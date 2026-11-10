// Run with: npx deno test -A supabase/functions/web_fetch_snapshot/
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isCustomerAccessError } from "./customer-access.ts";

Deno.test("customer field failures are retried without the field", () => {
  assertEquals(isCustomerAccessError("Access denied for customer field."), true);
  assertEquals(isCustomerAccessError("Required access: `read_customers` access scope."), true);
  assertEquals(isCustomerAccessError("This app is not approved to access the Customer object."), true);
});

Deno.test("other failures surface as themselves", () => {
  assertEquals(isCustomerAccessError("Throttled"), false);
  assertEquals(isCustomerAccessError("Orders query failed (502)"), false);
  assertEquals(isCustomerAccessError("Internal error. Looks like something went wrong on our end."), false);
  assertEquals(isCustomerAccessError(undefined), false);
});
