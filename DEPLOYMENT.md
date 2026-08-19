# Globex Time Attendance — ขั้นตอนติดตั้ง (~10 นาที)

## 1. สร้าง Apps Script project

1. เปิด https://script.google.com → **New project** → ตั้งชื่อ `Globex-Time-Attendance`
2. ลบโค้ดใน `Code.gs` แล้ว **paste ทั้งไฟล์** จาก `Code.gs` ใน repo นี้
3. **+** ข้าง Files → **HTML** → ตั้งชื่อ **`Index`** (I ใหญ่ ไม่ต้องพิมพ์ .html)
   → ลบเนื้อหา default แล้ว paste ทั้งไฟล์จาก `Index.html`
4. Save (Ctrl/Cmd+S)

> หรือใช้ clasp: แก้ `scriptId` ใน `.clasp.json` → `clasp push`

## 2. รัน SETUP ครั้งแรก

1. เลือกฟังก์ชัน **`SETUP_createAdmin`** → กด **Run**
2. กด **Review permissions** → เลือกบัญชี → Advanced → Go to … (unsafe) → **Allow**
3. ดู **Execution log** จะแสดง:
   - ลิงก์ spreadsheet ฐานข้อมูล (สร้างให้อัตโนมัติ ชื่อ "Globex Time Attendance DB")
   - บัญชีผู้ดูแล: **ADMIN / PIN 123456** ← login แล้วเปลี่ยน PIN ทันที (แท็บ 👥 พนักงาน → 🔑)

> อยากใช้ spreadsheet เดิม: ใส่ id ใน `CFG.DB_FILE_ID` บนหัวไฟล์ `Code.gs` ก่อนรัน SETUP

## 3. Deploy เป็น Web App

1. **Deploy → New deployment** → ⚙ เลือก **Web app**
2. ตั้งค่า **สำคัญ**:
   - **Execute as:** `Me` (บัญชีที่ deploy — พนักงาน outsource ไม่มีบัญชี Google ของโดเมน)
   - **Who has access:** `Anyone`
3. **Deploy** → copy **Web app URL** — นี่คือลิงก์ที่ทุกคนใช้ (มือถือได้)

> ความปลอดภัย: ทุก call ตรวจ token จากการ login ด้วย PIN ฝั่ง server · PIN เก็บเป็น salted hash
> · เวลาประทับจาก server · ทุกการเขียนลง audit log

## 4. เริ่มใช้งาน

1. เปิด Web app URL → login **ADMIN**
2. แท็บ **👥 พนักงาน** → ➕ เพิ่มพนักงาน: รหัส, ชื่อ, vendor, **กะเริ่ม-เลิก** (ใช้คิดสาย >10 นาที + OT), **PIN**
   - ตั้ง role `SUPERVISOR` ให้หัวหน้างานที่จะกดอนุมัติ/แก้เวลา/export
3. พนักงาน login ด้วย รหัส + PIN → กด **✓ เช็คอิน / 🏁 เช็คเอาท์** (หรือใช้โหมด **🖥 Kiosk** บนแท็บเล็ตส่วนกลาง)
4. OT: พนักงานยื่น **ก่อนปฏิบัติงาน** (ระบุชั่วโมง เที่ยวบิน เหตุผล) → SUPERVISOR อนุมัติ
   → ระบบนับจ่ายเฉพาะ ต่ำสุดของ(ชม.ทำจริงเกินกะ, ชม.ที่อนุมัติ)
5. สิ้นเดือน: แท็บ **📤 Export ตรวจรับ** → เลือกช่วงวันที่ → ได้ไฟล์ `.xlsx` 5 sheet
   (Daily Attendance / Timesheet / OT Timesheet / Leave / Summary) + สำเนาบน Google Sheets

## 5. อัปเดตโค้ดภายหลัง

paste ไฟล์ใหม่ทับ (หรือ `clasp push`) → **Deploy → Manage deployments → ✏️ → New version → Deploy**
(URL เดิมไม่เปลี่ยน)

## แก้ปัญหา

| อาการ | ทางแก้ |
|-------|--------|
| login แล้วขึ้น "ต้องเปิดผ่าน Web App URL" | เปิดจาก URL `/exec` ไม่ใช่ไฟล์ HTML ตรง ๆ |
| "SESSION_EXPIRED" | token หมดอายุ (6 ชม.) — login ใหม่ |
| export ได้แต่ลิงก์ Sheet ไม่ได้ .xlsx | ครั้งแรกอาจต้อง authorize scope เพิ่ม — รัน `TEST_ping` ใน editor แล้ว allow |
| ลืม PIN ADMIN | แก้ค่า `ADMIN_PIN` ใน `SETUP_createAdmin` แล้วรันซ้ำ |
