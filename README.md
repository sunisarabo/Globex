# Globex Time Attendance — ระบบลงเวลา Outsource (PSA-HKT)

โปรแกรมเดียวจบสำหรับจัดการ **เวลาเข้า-ออกงาน · OT · การลา** ของพนักงาน Outsource
พร้อม **Export ไฟล์ Excel สำหรับตรวจรับ** ตาม TOR งานจ้างเหมาบริการแรงงาน (Outsource) ของ บพท.

สร้างบน Google Apps Script (Web App) + Google Sheets เป็นฐานข้อมูล — ไม่ต้องมี server อื่น

## ทำอะไรได้

| งาน | รายละเอียด |
|-----|-----------|
| **เช็คอิน / เช็คเอาท์** | เวลาประทับโดย server เสมอ · มีโหมด Kiosk (แท็บเล็ตส่วนกลาง กรอกรหัส+PIN) และโหมด login ส่วนตัว · รองรับกะข้ามคืน · บันทึกจุดปฏิบัติงาน + เที่ยวบินได้ |
| **User รายพนักงาน** | login ด้วย รหัสพนักงาน + PIN (ไม่ต้องมีบัญชี Google) · 3 ระดับสิทธิ์: STAFF / SUPERVISOR / ADMIN |
| **ทะเบียนพนักงาน** | เพิ่ม / เปลี่ยนชื่อ / ปิดสถานะ / ตั้งกะ (เวลาเริ่ม-เลิก) / ตั้ง-รีเซ็ต PIN |
| **ขอ OT** | ยื่นก่อนปฏิบัติงาน → หัวหน้าอนุมัติ (ตาม TOR §3.1.2) · บังคับระบุ เที่ยวบิน + เหตุผล (§3.1.3) · **ชม.นับจ่าย = ต่ำสุดของ(ทำจริง, อนุมัติ)** (§3.1.5) · ห้ามอนุมัติคำขอตัวเอง |
| **ขอลา** | AL / SL / BL / ML / UL พร้อม workflow อนุมัติ |
| **ธงอัตโนมัติ** | สายเกิน **10 นาที** (TOR §11.2) · ออกก่อนเวลา · ไม่เช็คเอาท์ · OT เกินที่อนุมัติ |
| **Export Excel ตรวจรับ** | ไฟล์เดียว 5 sheet ตาม TOR §3.2.2 / §3.2.3 / §12: Daily Attendance · Timesheet · OT Timesheet · Leave · Summary (ชม.ทำงาน, ชม.OT, จำนวนพนักงานปฏิบัติงานจริงรายวัน, ประวัติเข้า-ออกรายบุคคล) |

## ไฟล์

| ไฟล์ | บทบาท |
|------|-------|
| `Code.gs` | server ทั้งหมด: auth (PIN hash), punch, คำขอ OT/ลา, สรุป, สร้าง Excel |
| `Index.html` | หน้าเว็บทั้งแอป (login / kiosk / บอร์ด / คำขอ / ทะเบียน / export) |
| `appsscript.json` | manifest — timezone Asia/Bangkok, Web App |
| `DEPLOYMENT.md` | ขั้นตอนติดตั้งทีละขั้น |

## ติดตั้ง (ย่อ)

1. สร้างโปรเจกต์ที่ script.google.com → paste `Code.gs` + `Index.html` (ชื่อไฟล์ HTML ต้องเป็น `Index`)
2. รัน `SETUP_createAdmin` หนึ่งครั้ง (สร้าง DB spreadsheet + ผู้ดูแล `ADMIN` / PIN `123456`)
3. Deploy → Web app → **Execute as: Me** · **Who has access: Anyone** → copy URL
4. เปิด URL → login `ADMIN` → เพิ่มพนักงาน + ตั้ง PIN → ใช้งานได้เลย
   (รายละเอียดเต็มใน `DEPLOYMENT.md`)

## Data model (สร้างอัตโนมัติใน spreadsheet "Globex Time Attendance DB")

- `Staff` — ทะเบียนพนักงาน (ชื่อ, vendor, กะ, สถานะ)
- `Users` — บัญชีผู้ใช้ (PIN เก็บเป็น salted SHA-256 hash, role)
- `Attendance` — 1 แถวต่อ (วันที่, พนักงาน): เวลาเข้า-ออกจริง, ชม.ปกติ, OT ทำจริง/อนุมัติ/นับจ่าย, ธง
- `Requests` — คำขอ OT/ลา + ผลอนุมัติ
- `Log` — audit log ทุกการเขียน

## ทดสอบ

รันด้วย Apps Script emulator (in-memory): **57 tests ผ่านทั้งหมด** — login/PIN, สิทธิ์ 3 ระดับ,
punch + สาย 10 นาที + กะข้ามคืน, OT approve → payable, ลา, scoping ข้อมูลตาม role, Excel export 5 sheet
