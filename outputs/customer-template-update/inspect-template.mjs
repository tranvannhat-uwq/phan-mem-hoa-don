import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const sourcePath = "D:/Desktop/weblendon/product-billing-app/Mau_Nhap_Danh_Sach_Khach_Hang.xlsx";
const outputDir = "D:/Desktop/weblendon/product-billing-app/outputs/customer-template-update";

const input = await FileBlob.load(sourcePath);
const workbook = await SpreadsheetFile.importXlsx(input);

const summary = await workbook.inspect({
  kind: "workbook,sheet,table,computedStyle",
  maxChars: 6000,
  tableMaxRows: 8,
  tableMaxCols: 16,
  tableMaxCellChars: 80,
});
console.log(summary.ndjson);

const preview = await workbook.render({
  sheetName: "DanhSachKhachHang",
  range: "A1:O6",
  scale: 1.5,
  format: "png",
});
await preview.save(`${outputDir}/before.png`);
