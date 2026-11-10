/** Whether a failed orders query failed because of the protected customer field
 * (a missing scope or access), the one failure a retry without that field can
 * fix. Anything else (throttling, a timeout, a bad token) must surface as
 * itself rather than be reported as "customer data unavailable". */
export function isCustomerAccessError(message: unknown): boolean {
  return /access|scope|customer/i.test(String(message ?? ""));
}
