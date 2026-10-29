// "custom" is the form's unassigned/individual-discount option, not a
// pricelists row. Do not change actual IDs or relax server price-list access.
export function normalizeNewCustomerPriceListId(value) {
  const id = String(value ?? '').trim();
  return !id || id === 'custom' ? null : id;
}
