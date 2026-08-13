import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';

const inputPath = 'D:/Downloads/weblendon_phase6_2026-08-05T13-07-02-934Z.xlsx';
const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);

function rowsFromSheet(name) {
  const sheet = workbook.worksheets.getItem(name);
  const values = sheet.getUsedRange(true).values;
  const headers = values[0].map(String);
  return values.slice(1).map((row, offset) => ({
    excelRow: offset + 2,
    data: Object.fromEntries(headers.map((header, index) => [header, row[index]])),
  }));
}

const priceLists = rowsFromSheet('Bang_Gia');
const priceItems = rowsFromSheet('Chi_Tiet_Bang_Gia');
const products = rowsFromSheet('San_Pham');
const customers = rowsFromSheet('Khach_Hang');
const orders = rowsFromSheet('Don_Hang');
const orderItems = rowsFromSheet('Chi_Tiet_Don');
const targetId = 'pl-1785406091157';
const targetPriceList = priceLists.find(row => row.data.id === targetId);
const targetCustomer = customers.find(row => row.data.id === targetPriceList?.data.customer_id)
  || customers.find(row => String(row.data.code || '').toLocaleLowerCase('vi').includes('anh thủy'));
const productById = new Map(products.map(row => [String(row.data.id), row.data]));
const targetItems = priceItems.filter(row => row.data.price_list_id === targetId);
const itemSummary = targetItems.map(row => {
  const product = productById.get(String(row.data.product_id)) || {};
  return {
    excelRow: row.excelRow,
    id: row.data.id,
    productId: row.data.product_id,
    productCode: product.code || '',
    productName: product.name || '',
    brand: product.brand || '',
    price: Number(row.data.price || 0),
    sourceType: row.data.source_type || '',
    updatedAt: row.data.updated_at || '',
  };
});
const byBrand = Object.values(itemSummary.reduce((acc, item) => {
  const key = item.brand || '(unknown)';
  acc[key] ||= { brand: key, rows: 0, zero: 0, nonzero: 0 };
  acc[key].rows += 1;
  if (item.price === 0) acc[key].zero += 1;
  else acc[key].nonzero += 1;
  return acc;
}, {})).sort((a, b) => b.rows - a.rows);
const targetOrders = orders.filter(row =>
  row.data.customer_id === targetCustomer?.data.id
  || String(row.data.customer_name || '').toLocaleLowerCase('vi').includes('anh thủy')
);
const targetOrderIds = new Set(targetOrders.map(row => String(row.data.id)));
const targetOrderItems = orderItems.filter(row => targetOrderIds.has(String(row.data.order_id)));

console.log(JSON.stringify({
  workbook: inputPath,
  targetPriceList: targetPriceList ? { excelRow: targetPriceList.excelRow, ...targetPriceList.data } : null,
  targetCustomer: targetCustomer ? {
    excelRow: targetCustomer.excelRow,
    id: targetCustomer.data.id,
    code: targetCustomer.data.code,
    name: targetCustomer.data.name,
    assignedBrand: targetCustomer.data.assigned_brand,
    priceListId: targetCustomer.data.pricelist_id,
    defaultPriceListId: targetCustomer.data.default_price_list_id,
    updatedAt: targetCustomer.data.updated_at,
  } : null,
  totals: {
    rows: itemSummary.length,
    zero: itemSummary.filter(item => item.price === 0).length,
    nonzero: itemSummary.filter(item => item.price !== 0).length,
  },
  byBrand,
  hataccoNonzero: itemSummary.filter(item => item.brand === 'HATACCO NANO' && item.price !== 0),
  hataccoZeroRange: itemSummary.filter(item => item.brand === 'HATACCO NANO' && item.price === 0)
    .map(item => item.excelRow),
  targetOrders: targetOrders.map(row => ({
    excelRow: row.excelRow,
    id: row.data.id,
    customerId: row.data.customer_id,
    customerName: row.data.customer_name,
    priceListId: row.data.pricelist_id,
    status: row.data.status,
    createdAt: row.data.created_at,
  })),
  targetOrderItems: targetOrderItems.map(row => ({
    excelRow: row.excelRow,
    orderId: row.data.order_id,
    productId: row.data.product_id,
    productCode: row.data.product_code_snapshot,
    productName: row.data.product_name_snapshot,
    quantity: row.data.quantity,
    unitPrice: row.data.unit_price,
    finalUnitPrice: row.data.final_unit_price,
    priceListId: row.data.price_list_id,
    salePrice: row.data.sale_price,
    listPrice: row.data.list_price,
  })),
}, null, 2));
