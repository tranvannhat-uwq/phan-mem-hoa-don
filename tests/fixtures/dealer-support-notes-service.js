// Read-only synthetic fixture; never connects to Supabase.
export const getRetentionSessionScope = () => 'synthetic-support-notes';
export const dbDealerSupportProducts = async () => ({ rows: [], total: 0 });
export const dbSetDealerSupportProducts = async () => ({ selected_count: 0 });
export const dbDealerSupportHistory = async () => ({ total: 3, selection_confirmed: true,
  rows: [
    { business_date: '2026-10-07T00:00:00+07:00', product_code: 'ÁO BẢO HỘ', product_name: 'Áo bảo hộ lao động', quantity: 5, unit_name: 'kg', order_notes: 'Giao cùng đơn sơn.\nGọi đại lý trước khi giao.' },
    { business_date: '2026-10-07T00:00:00+07:00', product_code: 'ÁO BẢO HỘ', product_name: 'Áo bảo hộ lao động', quantity: 5, unit_name: 'kg', order_notes: 'Gửi thêm 5 áo theo yêu cầu của đại lý.' },
    { business_date: '2026-09-18T00:00:00+07:00', product_code: 'QUẠT MÀU', product_name: 'Quạt màu bé', quantity: 1, unit_name: 'kg', order_notes: '' }
  ], summary: [ { product_code: 'ÁO BẢO HỘ', brand_name: 'Hãng kiểm thử', company_name: 'Công ty kiểm thử', issued: 10, returned: 0, remaining: 10, unit_name: 'kg' } ] });
