import type { LlmTool } from "../_shared/llm-adapter.ts";
import { askUserTool } from "../_shared/ask-user.ts";

const LINE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Service name shown in the pricing table" },
    description: { type: "string", description: "One-line description under the name" },
    content: { type: "string", description: "Markdown deliverables detail for this service" },
    one_time_price: { type: ["number", "null"], minimum: 0, description: "One-time fee in USD, or null. Never negative; use a discount to lower a total." },
    one_time_label: { type: ["string", "null"], description: "Label for the one-time fee, e.g. Implementation" },
    monthly_price: { type: ["number", "null"], minimum: 0, description: "Monthly fee in USD, or null. Never negative." },
    monthly_label: { type: ["string", "null"], description: "Label for the monthly fee, e.g. Ongoing management" },
    optional: {
      type: "boolean",
      description:
        "true for an add-on the client may choose to take when signing (it counts in no total until they tick it). Mark such a line optional: true; never name a line 'Optional: ...' instead. Leave false or omit for regular lines.",
    },
  },
  required: ["name", "description", "content", "one_time_price", "monthly_price"],
} as const;

const DISCOUNT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["none", "fixed", "percent"] },
    value: { type: "number", minimum: 0 },
    applies_to: { type: "string", enum: ["one_time", "monthly", "both"] },
    label: { type: ["string", "null"], description: "Short label shown next to the discount, e.g. Founding client rate" },
  },
  required: ["type", "value", "applies_to"],
} as const;

export const AGENT_TOOLS: LlmTool[] = [
  {
    name: "fetch_google_doc",
    description:
      "Fetch the text of a link-shared Google Doc (docs.google.com/document/... link). Use whenever the user shares a Google Docs URL. Fails with doc_private if the doc is not shared as 'Anyone with the link can view'.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The Google Docs URL the user shared" } },
      required: ["url"],
    },
  },
  {
    name: "fetch_fireflies_transcript",
    description:
      "Fetch the transcript and summary of a Fireflies meeting (app.fireflies.ai/view/... link). Use whenever the user shares a Fireflies link. Returns not_configured if no Fireflies API key is set, or not_authorized if the key is rejected.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string", description: "The Fireflies transcript URL the user shared" } },
      required: ["url"],
    },
  },
  {
    name: "get_templates",
    description:
      "List the agency's proposal templates with their section titles and default line items (names and prices). Use to ground drafts in real services and pricing before proposing.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_contracts",
    description: "List the agency's contract documents (slug and name) that can be attached to a proposal.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_clients",
    description:
      "List the agency's clients (id, company name, contact name). Use when no proposal is open and you need to identify which client the proposal is for.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_proposals",
    description:
      "Search the agency's PAST proposals by keyword (matches the proposal title and the client's company name). Use this whenever the user references an existing or previous proposal by name, e.g. 'structure it like the Celtic Sea Salt proposal' or 'the one we sent Rusty Surfboards'. Returns matching proposals with id, title, client, status, and date. Then call get_proposal on the best match to read its full structure.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to match against proposal titles and client company names, e.g. 'Celtic Sea Salt'" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_proposal",
    description:
      "Read the full content of one past proposal by its id (from search_proposals): its sections (titles and body), line items with pricing, discount, and attached contracts. Use it to model a new draft's structure and depth on a proposal the user referenced. Always adapt the content to the current client and project; never copy another client's private facts verbatim.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The proposal id returned by search_proposals" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_client_history",
    description:
      "Get a fuller history for the CURRENT client (the one this proposal is for): more of their past proposals (titles, sections, line items, pricing, status) and their most recent audit (background, meeting notes, revenue opportunity, chosen add-ons). A short summary is already provided in WHAT WE ALREADY KNOW ABOUT THIS CLIENT; call this only when you need more depth than that summary. No arguments needed.",
    input_schema: { type: "object", properties: {} },
  },
  askUserTool(
    "Use it when a decision materially shapes the proposal and the answer is not available.",
  ),
  {
    name: "propose_draft",
    description:
      "Propose a complete new proposal. The user sees a preview card and applies it manually. Use only when you have enough information about client, scope, services, and pricing. This ends your turn.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Proposal title, e.g. 'Klaviyo Email Program for Acme'" },
        client_id: { type: ["string", "null"], description: "Client id from get_clients, if known and no proposal is open" },
        recipient_name: { type: ["string", "null"], description: "The contact who will receive and sign" },
        recipient_email: { type: ["string", "null"] },
        content_blocks: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              content: { type: "string", description: "Markdown body of the section" },
            },
            required: ["title", "content"],
          },
        },
        line_items: { type: "array", minItems: 1, items: LINE_ITEM_SCHEMA },
        discount: DISCOUNT_SCHEMA,
        include_contracts: {
          type: "array",
          items: { type: "string" },
          description: "Contract slugs from get_contracts to attach",
        },
        summary: { type: "string", description: "1-2 sentences describing the draft, shown on the preview card" },
        agency_signer: {
          type: "string",
          description:
            "WHOSE signature signs this proposal for ECD, when the user named someone ('make it signed by Xiomara'). A first name, full name or email. Leave empty to use the team default (Zak). Never guess a name the user did not say.",
        },
      },
      required: ["title", "content_blocks", "line_items", "summary"],
    },
  },
  {
    name: "propose_edits",
    description:
      "Propose a set of edits to the currently open proposal. The user sees a preview of the operations and applies them manually. Reference block keys and line item ids from CURRENT PROPOSAL STATE. This ends your turn.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "1-2 sentences describing the edits, shown on the preview card" },
        operations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "update_title",
                  "update_block",
                  "add_block",
                  "remove_block",
                  "add_line_item",
                  "update_line_item",
                  "delete_line_item",
                  "update_discount",
                  "toggle_contract",
                  "override_contract",
                  "update_recipient",
                  "set_agency_signer",
                ],
              },
              title: { type: "string", description: "For update_title / add_block / update_block" },
              block_key: {
                type: "string",
                description:
                  "For update_block / remove_block. A block marked truncated: true in CURRENT PROPOSAL STATE was too long to send in full: never send content for it (you may still change its title).",
              },
              after_key: { type: ["string", "null"], description: "For add_block: insert after this block key, null = at the end" },
              content: {
                type: "string",
                description:
                  "For update_block / add_block: full replacement markdown. Never for a block marked truncated: true, since you only see the start of it and the rest would be lost.",
              },
              item: { ...LINE_ITEM_SCHEMA, description: "For add_line_item" },
              item_id: { type: "string", description: "For update_line_item / delete_line_item" },
              patch: {
                type: "object",
                description: "For update_line_item: only the fields to change",
                properties: LINE_ITEM_SCHEMA.properties,
              },
              discount: { ...DISCOUNT_SCHEMA, description: "For update_discount" },
              slug: { type: "string", description: "For toggle_contract / override_contract" },
              included: { type: "boolean", description: "For toggle_contract" },
              contract_edits: {
                type: "array",
                description:
                  "For override_contract, PREFERRED: redline edits to the contract for this proposal only. Each item quotes a passage VERBATIM from get_contracts (find) and gives its replacement (replace). The server assembles the full document. Use this for any change short of rewriting the whole contract.",
                items: {
                  type: "object",
                  required: ["find", "replace"],
                  properties: {
                    find: { type: "string", description: "Exact text currently in the contract, long enough to appear only once (a full clause or sentence)." },
                    replace: { type: "string", description: "The new text for that passage. To delete a passage, send an empty string." },
                  },
                },
              },
              contract_content: {
                type: ["string", "null"],
                description:
                  "For override_contract, ONLY when the whole contract must be restructured: the full replacement text FOR THIS PROPOSAL ONLY. This is slow and fails on long contracts, so prefer contract_edits. Pass null to drop the override and go back to the shared version.",
              },
              recipient_name: { type: "string", description: "For update_recipient" },
              recipient_email: { type: "string", description: "For update_recipient" },
              signer: {
                type: "string",
                description:
                  "For set_agency_signer: WHOSE signature signs this proposal for ECD, as a first name, full name or email ('Zak', 'zak@ecdigitalstrategy.com'). Use only when the user asks to change who signs. Proposals are signed by Zak by default.",
              },
            },
            required: ["op"],
          },
        },
      },
      required: ["summary", "operations"],
    },
  },
];

export const TERMINAL_TOOLS = new Set(["ask_user", "propose_draft", "propose_edits"]);
