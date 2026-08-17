# Globex — Time Attendance for Outsource Staff (PSA-HKT)

ระบบ **เช็คอิน–เช็คเอาท์ · ขอ OT · ขอลา** สำหรับพนักงาน Outsource
สร้างบน Google Apps Script (standalone Web App) + Google Sheets เป็นฐานข้อมูล
ต่อยอดจากแอป PSA-HKT Roster/Assignment เดิม — ใช้ roster, ทีม และ Users tab ชุดเดียวกัน

## ไฟล์ในโปรเจกต์

| ไฟล์ | บทบาท |
|------|-------|
| `apps-script-bridge.gs` | โค้ดฝั่ง server ทั้งหมด (Code.gs) — API, สิทธิ์, ลงเวลา, คำขอ OT/ลา, importer |
| `Index.html` | หน้าเว็บทั้งแอป (เสิร์ฟผ่าน HtmlService) |
| `DEPLOYMENT.md` | ขั้นตอน deploy ทีละขั้น (ภาษาไทย) |
| `appsscript.json` | manifest — timezone Asia/Bangkok, Web App run-as user |
| `.clasp.json` | สำหรับ push ด้วย `clasp` (แก้ `scriptId` ให้ตรงกับโปรเจกต์ของคุณ) |

## ฟีเจอร์หลัก

- **เช็คอิน / เช็คเอาท์** — เวลาประทับโดย server เสมอ (แก้จาก browser ไม่ได้)
  พนักงานลงเวลาของตัวเองผ่านการจับคู่อีเมล · supervisor (Users tab) ลงเวลาแทน/แก้ย้อนหลังได้
  รองรับกะข้ามคืน · ธง `LATE` / `EARLY_OUT` / `NO_OUT` / `WORK_ON_OFF` / `OT_UNAPPROVED`
- **OT** — คำนวณจากชั่วโมงจริงที่เกินความยาวกะใน roster (ปัดลงทีละ 30 นาที)
  เทียบกับจำนวนชั่วโมงที่อนุมัติผ่านคำขอ
- **ขอ OT / ขอลา + อนุมัติ** — กันคำขอซ้อนช่วงวัน · ห้ามอนุมัติคำขอตัวเอง
  อนุมัติลาแล้วเขียนรหัส `SL`/`BL`/`AL`/`Vac` ลง roster ให้อัตโนมัติ (ยกเลิก/กลับคำ = คืนรหัสกะเดิม)
- **ทะเบียน Outsource** — เก็บใน tab `Outsource` ของ Roster DB แยกจาก staff master
  พร้อม importer อ่านไฟล์รายงานส่งแรงงานรายเดือนของ vendor (รูปแบบ `Jan - May 2026Globex.xlsx`)
- **หน้า UI** — 🕒 Check-In/Out (บอร์ดรายวัน · Kiosk · รายงาน+CSV · ทะเบียน) และ 📝 OT & Leave

## Data model (สร้างอัตโนมัติใน Roster DB spreadsheet)

- `Outsource` — ทะเบียนพนักงาน vendor
- `Attendance` — 1 แถวต่อ (วันที่, รหัสพนักงาน)
- `Requests` — คำขอ OT/ลา + ผลการอนุมัติ

## Deploy

ดู `DEPLOYMENT.md` — สรุปสั้น: สร้าง Apps Script project → paste สองไฟล์ →
ตั้ง `CFG` file IDs → Deploy เป็น Web App (**Execute as: User accessing** · access ภายในโดเมน)
