const fs = require('fs');
const path = require('path');

// We will write a script to generate the CSV / Excel template.
// Since Node.js might not have 'xlsx' installed by default, we can write a JS script
// that dynamically installs 'xlsx' locally if not present, and then uses it to write a clean Excel file.

const products = [
  // --- BỘT BẢ, NHŨ VÀNG, KEO PHỦ ---
  { code: 'BN', name: 'Bột bả nội thất cao cấp', brand: 'Nano10*', priceThung: 0, priceLon: 0, priceHop: 0, priceBao: 650000, priceTui: 0 },
  { code: 'BG-01', name: 'Bột bả ngoại thất cao cấp (Bao)', brand: 'Nano10*', priceThung: 0, priceLon: 0, priceHop: 0, priceBao: 800000, priceTui: 0 },
  { code: 'BG-02', name: 'Bột bả ngoại thất cao cấp (Túi)', brand: 'Nano10*', priceThung: 0, priceLon: 0, priceHop: 0, priceBao: 0, priceTui: 125000 },
  { code: 'UV-11', name: 'Nhũ vàng 24K', brand: 'Nano10*', priceThung: 0, priceLon: 0, priceHop: 900000, priceBao: 0, priceTui: 0 },
  { code: 'B-H2', name: 'Keo phủ bóng bề mặt sơn', brand: 'Nano10*', priceThung: 0, priceLon: 1625000, priceHop: 0, priceBao: 0, priceTui: 0 },

  // --- SƠN NỘI THẤT ---
  { code: 'NT-KT1', name: 'Sơn nước nội thất KT', brand: 'Nano10*', priceThung: 995459, priceLon: 362124, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NX-KT2', name: 'Sơn siêu mịn nội thất KT', brand: 'Nano10*', priceThung: 1272379, priceLon: 531703, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'BM-H1', name: 'Sơn bóng mờ nội thất cao cấp', brand: 'Nano10*', priceThung: 4144953, priceLon: 1381652, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NT-B1', name: 'Sơn siêu bóng nội thất cao cấp', brand: 'Nano10*', priceThung: 4989842, priceLon: 1663276, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NX-B1', name: 'Sơn siêu bóng nội thất đặc biệt', brand: 'Nano10*', priceThung: 5288000, priceLon: 1763000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NT-899', name: 'Sơn men sứ nội thất cao cấp 9in1', brand: 'Nano10*', priceThung: 5341866, priceLon: 1780620, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'TT-G1', name: 'Sơn siêu trắng trần nội thất cao cấp', brand: 'Nano10*', priceThung: 2778000, priceLon: 926000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NX-G1', name: 'Sơn siêu trắng trần nội thất đặc biệt', brand: 'Nano10*', priceThung: 3075000, priceLon: 1025000, priceHop: 0, priceBao: 0, priceTui: 0 },

  // --- SƠN NGOẠI THẤT ---
  { code: 'NX-KT1', name: 'Sơn siêu mịn ngoại thất KT', brand: 'Nano10*', priceThung: 1440916, priceLon: 550000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'SM-G2', name: 'Sơn siêu mịn ngoại thất cao cấp', brand: 'Nano10*', priceThung: 3244000, priceLon: 1081000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'BM-H2', name: 'Sơn bóng mờ ngoại thất cao cấp', brand: 'Nano10*', priceThung: 5295000, priceLon: 1765000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NT-B2', name: 'Sơn siêu bóng ngoại thất cao cấp', brand: 'Nano10*', priceThung: 5998000, priceLon: 1999000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NX-B2', name: 'Sơn siêu bóng ngoại thất đặc biệt', brand: 'Nano10*', priceThung: 6349000, priceLon: 2116000, priceHop: 615000, priceBao: 0, priceTui: 0 },
  { code: 'NX-999', name: 'Sơn men sứ ngoại thất cao cấp 10in1', brand: 'Nano10*', priceThung: 6375775, priceLon: 2125257, priceHop: 620000, priceBao: 0, priceTui: 0 },

  // --- SƠN GIẢ ĐÁ ---
  { code: 'ĐV-98', name: 'Sơn giả đá hạt cao cấp', brand: 'Nano10*', priceThung: 5113661, priceLon: 1136369, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'HP-99', name: 'Sơn giả đá hoa cương', brand: 'Nano10*', priceThung: 5318207, priceLon: 1181824, priceHop: 0, priceBao: 0, priceTui: 0 },

  // --- CHỐNG THẤM ---
  { code: 'SIKA-01 A+B', name: 'Chống thấm sàn chuyên dụng', brand: 'Nano10*', priceThung: 1363636, priceLon: 1363636, priceHop: 0, priceBao: 0, priceTui: 0 }, // Bộ 15kg (Lon 4.5kg + Bao 10.5kg) giá 1,363,636
  { code: 'H2-1-1', name: 'Sơn chống thấm trộn xi măng', brand: 'Nano10*', priceThung: 3994000, priceLon: 1331000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'ĐN-H2', name: 'Sơn chống thấm màu đa năng', brand: 'Nano10*', priceThung: 5276000, priceLon: 1759000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'CT-TS2', name: 'Keo chống thấm trong suốt', brand: 'Nano10*', priceThung: 6954578, priceLon: 2045464, priceHop: 431820, priceBao: 0, priceTui: 0 },
  { code: 'CT-RF201', name: 'Keo chống thấm màu lộ thiên', brand: 'Nano10*', priceThung: 6954578, priceLon: 2045464, priceHop: 431820, priceBao: 0, priceTui: 0 },

  // --- SƠN LÓT ---
  { code: 'NX-KT3', name: 'Sơn lót chống kiềm siêu mịn nội thất KT', brand: 'Nano10*', priceThung: 995459, priceLon: 362124, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NT-ĐO', name: 'Sơn lót chống kiềm nội thất KT (ĐO)', brand: 'Nano10*', priceThung: 2445712, priceLon: 815236, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NT-Đ1', name: 'Sơn lót chống kiềm nội thất cao cấp', brand: 'Nano10*', priceThung: 2695013, priceLon: 898336, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NX-Đ1', name: 'Sơn lót chống kiềm nội thất đặc biệt', brand: 'Nano10*', priceThung: 2995000, priceLon: 998000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NX-KT5', name: 'Sơn lót chống kiềm siêu mịn ngoại thất KT', brand: 'Nano10*', priceThung: 1440916, priceLon: 480307, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NT-Đ2', name: 'Sơn lót chống kiềm ngoại thất cao cấp', brand: 'Nano10*', priceThung: 3642000, priceLon: 1214000, priceHop: 0, priceBao: 0, priceTui: 0 },
  { code: 'NX-Đ2', name: 'Sơn lót chống kiềm ngoại thất đặc biệt', brand: 'Nano10*', priceThung: 4125000, priceLon: 1375000, priceHop: 0, priceBao: 0, priceTui: 0 }
];

// Helper to ensure 'xlsx' package is installed
function run() {
  try {
    const XLSX = require('xlsx');
    writeExcel(XLSX);
  } catch (err) {
    console.log("XLSX is not installed. Installing it now...");
    const { execSync } = require('child_process');
    execSync('npm install xlsx', { stdio: 'inherit' });
    const XLSX = require('xlsx');
    writeExcel(XLSX);
  }
}

function writeExcel(XLSX) {
  const headers = [['Mã SP', 'Tên sản phẩm', 'Hãng sơn', 'Giá Thùng', 'Giá Lon', 'Giá Hộp', 'Giá Bao', 'Giá Túi']];
  const rows = products.map(p => [
    p.code,
    p.name,
    p.brand,
    p.priceThung,
    p.priceLon,
    p.priceHop,
    p.priceBao,
    p.priceTui
  ]);

  const sheetData = headers.concat(rows);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);

  ws['!cols'] = [
    { wch: 15 }, // Mã SP
    { wch: 45 }, // Tên sản phẩm
    { wch: 15 }, // Hãng sơn
    { wch: 15 }, // Giá Thùng
    { wch: 15 }, // Giá Lon
    { wch: 15 }, // Giá Hộp
    { wch: 15 }, // Giá Bao
    { wch: 15 }  // Giá Túi
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Danh Sach San Pham");
  
  const destPath = path.join(__dirname, 'Danh_Sach_San_Pham_Nano10.xlsx');
  XLSX.writeFile(wb, destPath);
  console.log(`Successfully created Excel file at: ${destPath}`);
}

run();
