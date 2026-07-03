// Cấu hình URL và Anon Key kết nối Supabase mặc định của công ty
export const COMPANY_SUPABASE_URL = "https://coebrkerpcgwckkwxlfo.supabase.co"; 
export const COMPANY_SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNvZWJya2VycGNnd2Nra3d4bGZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIxNTA2MDAsImV4cCI6MjA5NzcyNjYwMH0.3Y5ECisaADSefH8il1ECWGC1sd1Mh-PzWXM1CV2xTXw"; 

// Danh sách sản phẩm mặc định (dùng khi chạy Offline cục bộ)
export const defaultProducts = [
  { code: 'SP001', name: 'Sơn bóng ngoại thất WeatherShield', brand: 'Nano10*', priceThung: 1250000, priceLon: 380000, priceHop: 120000, priceBao: 0, priceTui: 0 },
  { code: 'SP002', name: 'Sơn lót kháng kiềm Ultra Primer', brand: 'mutsutec', priceThung: 950000, priceLon: 290000, priceHop: 90000, priceBao: 0, priceTui: 0 },
  { code: 'SP003', name: 'Sơn phủ nội thất Nippon Odourless', brand: 'tdkaw', priceThung: 1100000, priceLon: 350000, priceHop: 110000, priceBao: 0, priceTui: 0 },
  { code: 'SP004', name: 'Sơn nhũ vàng kim loại cao cấp', brand: 'cova', priceThung: 650000, priceLon: 180000, priceHop: 60000, priceBao: 0, priceTui: 0 },
  { code: 'SP005', name: 'Sơn phủ chống thấm màu Waterblock', brand: 'festivanano', priceThung: 1450000, priceLon: 450000, priceHop: 140000, priceBao: 0, priceTui: 0 },
  { code: 'SP006', name: 'Bột bả tường cao cấp Nano10*', brand: 'Nano10*', priceThung: 0, priceLon: 0, priceHop: 0, priceBao: 280000, priceTui: 60000 },
  { code: 'SP007', name: 'Chống thấm chuyên dụng Sika Latex', brand: 'Hatacco nano', priceThung: 850000, priceLon: 250000, priceHop: 0, priceBao: 0, priceTui: 75000 }
];
