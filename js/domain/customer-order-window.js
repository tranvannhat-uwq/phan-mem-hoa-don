// IDs travel in a POST body rather than a potentially 40+ KB query string.
// Both existing consumers retain their date/status/order/page semantics.
export async function fetchCustomerOrderWindow(rpc, {
  customerIds, start = null, end = null, status = null,
  dateField = 'business', limit = 500, allPages = false
}) {
  const ids = [...new Set((customerIds || []).map(id => String(id)).filter(Boolean))];
  if (!ids.length) return [];
  const pageSize = Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 500)));
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await rpc('rpc_get_customer_order_window', {
      p_customer_ids: ids, p_start: start, p_end: end,
      p_status: status, p_date_field: dateField, p_limit: pageSize, p_offset: offset
    });
    if (error) throw error;
    if (!Array.isArray(data) || data.length > pageSize) throw new Error('Dữ liệu lịch sử đơn hàng không hợp lệ.');
    rows.push(...data);
    if (!allPages || data.length < pageSize) return rows;
  }
}
