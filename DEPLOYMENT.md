# PSA-HKT Assignment Bridge — Deployment Guide

## 1. Files / Sheets ที่ต้องเตรียม

| ไฟล์ | ID | บทบาท | Tab ที่ใช้ |
|------|-----|-------|----------|
| **Pax Manpower (Staff + Master)** | `1oqKI1lbXDow6JCHCOqRIhT7o7dI9U9zfpyV8CJGOUJ8` | staff (Total) + auth (Users) + audit (Logs) | `Total`, `Users`, `Logs` |
| **Flights** | `1Y3ft-vkHQ5Rm2LVmq1Zz_2j8n5T8wLgCJtdBKhqfBAA` | flight schedule | tab แรก |
| **Assignment (SmartShift)** | `1UDfFDWDihh71c_mNuZ96xAeGGZqKbL-ITFHx8eh7PMA` | เก็บผล (1 tab/วัน รูปแบบ `ddMMM`) | auto-create |

> **หมายเหตุ:** Apps Script bridge นี้เป็นโปรเจกต์ standalone — ไม่ผูกกับชีตใดชีตหนึ่ง อ้างทุก ID ผ่าน `CFG`

---

## 2. ขั้นตอน Deploy (~ 10 นาที)

### 2.1 สร้าง Apps Script project
1. `drive.google.com` → คลิก **New** → **More** → **Google Apps Script**
2. ตั้งชื่อ: `PSA-HKT-Assignment-Bridge`
3. ลบโค้ดเริ่มต้นใน `Code.gs` ทั้งหมด
4. **paste** เนื้อหาจากไฟล์ `apps-script-bridge.gs` ทั้งไฟล์
5. เพิ่มไฟล์ HTML: **+** ข้าง Files → **HTML** → ตั้งชื่อ **`Index`** (ตัวพิมพ์ใหญ่ I, ไม่ต้องใส่ `.html`)
6. ลบเนื้อหา default ใน `Index.html` → **paste** เนื้อหาจากไฟล์ `Index.html` ทั้งไฟล์
7. Save (Cmd+S / Ctrl+S)

> หน้าเว็บถูกเสิร์ฟ **จากตัว Apps Script เอง** ผู้ใช้จึงรันแบบ same-origin และ
> `google.script.run` ส่ง identity ของผู้ใช้ไปถึง server จริง (per-user write
> gate ทำงาน) — ไม่มี cross-origin fetch ที่ทำ identity หลุดอีกต่อไป

### 2.2 ตั้งค่า CFG
ในโค้ดส่วน `CFG = {...}` ค่า default ตั้งไว้ครบแล้ว (Pax Manpower = Staff master ไฟล์เดียวกัน):
```js
STAFF_FILE_ID:      '1oqKI1lbXDow6JCHCOqRIhT7o7dI9U9zfpyV8CJGOUJ8'
MASTER_FILE_ID:     '1oqKI1lbXDow6JCHCOqRIhT7o7dI9U9zfpyV8CJGOUJ8'  // same file
FLIGHT_FILE_ID:     '1Y3ft-vkHQ5Rm2LVmq1Zz_2j8n5T8wLgCJtdBKhqfBAA'
ASSIGNMENT_FILE_ID: '1UDfFDWDihh71c_mNuZ96xAeGGZqKbL-ITFHx8eh7PMA'
STAFF_TAB:          'Total'   // tab ของ staff ภายใน Pax Manpower
```
**ถ้าไม่ต้องการ auth gate** ตั้ง `ALLOWED_WRITERS: ['*']` หรือลบ Users tab ออก → user ในโดเมน aotga.com ทุกคน write ได้

### 2.3 Authorize permissions
1. คลิกเมนู **▶ Run** ที่ฟังก์ชัน `TEST_me`
2. กด **Review permissions** → เลือกบัญชี → **Advanced** → **Go to PSA-HKT-Assignment-Bridge (unsafe)** → **Allow**
3. ดู Logger (View → Executions → Logs) → ควรเห็น email ของคุณ + `authorized=true`

### 2.4 Test reads
รัน function เหล่านี้ทีละตัว ดู log ใน Executions:
- `TEST_pullStaff` → ควรเห็น array ของพนักงาน 5 คน (i, n, ln, p, t)
- `TEST_pullFlights` → ควรเห็น flight วันนี้ (ถ้าไม่มี data วันนี้ ใน Sheet จะได้ `[]`)
- `TEST_pullAssignments` → จะ auto-create tab ของวันนี้ (เช่น `13MAY`) แล้วคืน `{}`

ถ้า error เรื่อง column → ดู `_colMap` ในโค้ด แล้วเพิ่ม alias ของคอลัมน์จริงในชีต

### 2.5 Test write (ทำหลัง read ผ่านแล้ว)
- `TEST_writeOne` → ควร insert 1 row ใน tab วันที่กำหนด
- ตรวจใน Sheet ไฟล์ Assignment → tab `13MAY` ควรมี row ใหม่

### 2.5b Test auto-assigner
- `TEST_autoAssign` → solver จะ run สำหรับทีม EK วันนี้ (ปรับใน function ได้)
- `TEST_autoAssignAll` → solver run ทุกทีม
- ดู log: `assigned=NN violations=X flights=YY`
- ถ้า `violations` ไม่ว่าง = พบ flight/role ที่ pool หา candidate ไม่ได้

### 2.6 Deploy เป็น Web App
1. คลิก **Deploy** (มุมขวาบน) → **New deployment**
2. ⚙ icon → **Web app**
3. ตั้งค่า:
   - **Description:** PSA-HKT Assignment Bridge v1
   - **Execute as:** **User accessing the web app** ⚠ สำคัญ — ไม่ใช่ "Me"
   - **Who has access:** **Anyone within aotga.com**
4. คลิก **Deploy**
5. **Copy Web app URL** (เช่น `https://script.google.com/a/macros/aotga.com/s/AKfyc.../exec`)

### 2.7 ทดสอบ URL จาก browser
1. **เปิดแอป:** เปิด `<WEB_APP_URL>` ตรง ๆ (ไม่มี `?action=`) — login @aotga.com ก่อน
   → ควรเห็นหน้า Dashboard และ pill มุมขวาล่างเป็น **🟢 live · can edit** ภายใน ~1 วิ
2. **เช็ค identity (ถ้า pill ยัง read-only):** เปิด `<WEB_APP_URL>?action=whoami`
   → ดูฟิลด์ `reason` จะบอกว่าทำไม `canWrite` true/false (เช่น email ไม่อยู่ใน Users tab)
3. **ping:** `<WEB_APP_URL>?action=ping` → `{"ok":true,"you":"your.name@aotga.com",...}`

⚠ **อย่าเปิดไฟล์ `Index.html` ตรง ๆ จากเครื่อง** (double-click / file://) — แบบนั้น
`google.script.run` ไม่มี → แอปจะรัน local-only (pill 🔴 offline) ต้องเปิดผ่าน
Web App URL เท่านั้น แล้ว bookmark URL นั้นแจกให้ทีม

---

## 3. Update โค้ดด้วย clasp (แนะนำ — ไม่ต้อง copy-paste)

repo มี `.clasp.json` / `appsscript.json` / `.claspignore` ตั้งไว้แล้ว
clasp จะ push **เฉพาะ 3 ไฟล์**: `apps-script-bridge.gs` (→ server),
`Index.html` (→ HTML file ชื่อ `Index`), `appsscript.json` (manifest).

### 3.0 ตั้งครั้งเดียว
1. หา **Script ID**: เปิด Apps Script project → ⚙ **Project Settings** →
   คัดลอก *Script ID* (หรือจาก URL `.../projects/<SCRIPT_ID>/edit`)
2. แก้ `.clasp.json` → แทน `PUT_YOUR_SCRIPT_ID_HERE` ด้วย Script ID จริง
3. บนเครื่องตัวเอง (มี Node):
   ```
   npx clasp login            # login Google ครั้งเดียว (เปิด browser)
   ```

### 3.1 ทุกครั้งที่อัปเดต
```
git pull                                  # ดึงโค้ดล่าสุดจาก PR/branch
npx clasp push -f                          # ดันขึ้น Apps Script (overwrite)
```
- ทดสอบทันทีที่ **`<WEB_APP_URL>/dev`** — เสิร์ฟโค้ดล่าสุดที่ push เสมอ
  (ไม่ต้อง bump version)
- พร้อมใช้จริงค่อยอัป `/exec`:
  ```
  npx clasp deployments                    # ดู deploymentId ที่ใช้อยู่
  npx clasp deploy -i <deploymentId> -d "update"
  ```
  URL `/exec` เดิมใช้ต่อได้ ไม่ต้องแจกใหม่

⚠ `clasp push` จะ **เขียนทับทั้งโปรเจกต์** ด้วย 3 ไฟล์นี้ — ไฟล์ `Code.gs`
เดิมในโปรเจกต์จะถูกแทนที่ (ไม่เป็นไร โค้ด server อยู่ใน
`apps-script-bridge.gs` ครบแล้ว) · `appsscript.json` จะทับ manifest เดิม
→ อาจต้องกด re-authorize รอบแรก (ปกติ)

### 3b. วิธีเดิม (copy-paste ด้วยมือ — ถ้าไม่ใช้ clasp)
1. แก้ไฟล์ใน Apps Script → Save
2. **Deploy → Manage deployments** → ✏️ edit → **Version:** New version → **Deploy**
3. URL เดิมใช้ต่อได้

⚠ ถ้ากด "New deployment" จะได้ URL ใหม่ → ต้อง update ใน HTML ทั้ง 5+ เครื่อง

---

## 4. Auth model ที่ใช้

```
Browser เปิด Web App URL
   │ Google validates user's @aotga.com session
   ▼
doGet() → HtmlService เสิร์ฟ Index.html (same-origin)
   │
   ▼ หน้าเว็บเรียก google.script.run.bootstrapData()/writeAssignment()/...
   │  (รันใน session ของผู้ใช้ — ไม่มี cross-origin fetch)
   ▼
Session.getActiveUser().getEmail()  →  ได้ email จริง
   │
   ▼
isAuthorized(email)
   ├── ALLOWED_WRITERS ถ้าตั้งไว้
   ├── Users tab ใน Master File (Pax Manpower)
   └── ถ้าไม่ตั้งทั้ง 2 → ผ่านทุกคนในโดเมน
```

**SNR ใช้เมล์ทีม** → ทำงานได้เพราะเมล์ทีมก็คือบัญชี Workspace
**PSA ไม่มีเมล์** → เปิด HTML ไม่ได้ — แต่ PSA ไม่ต้อง assign อยู่แล้ว (เป็นผู้ถูก assign)

---

## 5. Multi-user safety

- `LockService.getDocumentLock()` รอ 8 วินาที ถ้ามีคนอื่น write อยู่
- Lock ใช้ **per script** = serializing ทุก write request ระดับ script
- ถ้า 5 คนกด assign พร้อมกัน → คนที่ 5 รอ ~ 2-3 วินาที (ปกติ)
- ทุก write ลง `Logs` tab → ดู audit ได้

---

## 6. ต่อจากนี้

หลังจาก Apps Script พร้อม:
1. ✅ Bridge พร้อม (read/write/auth/lock/audit)
2. ✅ Server-side solver พร้อม (`autoAssignDay` ใช้ SLA 60+ airlines)
3. ✅ HTML เสิร์ฟผ่าน Apps Script + write-through ผ่าน `google.script.run`
4. ✅ poll ทุก 10 วินาที (auto-refresh state.assignments)

---

## 7. Troubleshooting

| ปัญหา | สาเหตุ | แก้ |
|------|--------|-----|
| pill 🔴 offline / `not served by Apps Script` | เปิดไฟล์ตรง ๆ (file://) | เปิดผ่าน Web App URL เท่านั้น |
| pill 🔵 read-only | email ไม่อยู่ใน Users tab | เปิด `?action=whoami` ดู `reason` → เพิ่ม email ใน Users tab |
| หน้าเว็บว่าง / `Index ... not found` | ไม่ได้สร้างไฟล์ HTML ชื่อ `Index` | เพิ่มไฟล์ HTML ชื่อ `Index` (ข้อ 2.1) แล้ว redeploy |
| `unauthorized: ...` | email ไม่อยู่ใน Users tab | เพิ่มใน Users tab ของ Pax Manpower |
| `Staff tab not found` | ชื่อ tab ผิด | ใส่ใน `CFG.STAFF_TAB` หรือ empty = first tab |
| `รหัสพนักงาน` มี `.0` ต่อท้าย | Sheet เก็บเป็น number | script handle ให้แล้ว (`.replace(/\.0$/,'')`) |
| Flight ไม่มา | column header ไม่ตรง | ดู `_colMap(headers, {...})` ใน `pullFlights` เพิ่ม alias |
| `team: null` | airline ไม่อยู่ใน `AIRLINE_TO_TEAM` | เพิ่มใน mapping ตอนต้นไฟล์ |
| Lock timeout | มีคน write นาน | เพิ่ม `tryLock(15000)` ถ้าเกิดบ่อย |

---

## 8. Time Attendance — เช็คอิน/เช็คเอาท์ · ขอ OT · ขอลา (พนักงาน Outsource)

### 8.1 โครงสร้างข้อมูล
สามแท็บใหม่ ถูกสร้าง **อัตโนมัติ** ในไฟล์ Roster DB (`CFG.ROSTER_FILE_ID`):

| Tab | บทบาท |
|-----|-------|
| `Outsource` | ทะเบียนพนักงาน outsource (EmpID, ชื่อ, Vendor, Team, Email, สัญญา) |
| `Attendance` | บันทึกลงเวลา 1 แถว/คน/วัน (In/Out ประทับเวลาโดย **server**, ชม.ทำงาน, OT, ธงเตือน) |
| `Requests` | คำขอ OT / ลา + ผลอนุมัติ (ReqID เช่น `OT-20260817-01`, `LV-…`) |

### 8.2 สิทธิ์การใช้งาน
- **ผู้อยู่ใน Users tab (writer):** ลงเวลาแทนใครก็ได้ · แก้เวลาย้อนหลัง · อนุมัติ/ไม่อนุมัติคำขอ · จัดการทะเบียน Outsource
- **พนักงานทั่วไปในโดเมน:** ลงเวลา **ของตัวเองเท่านั้น** — ระบบจับคู่บัญชี Google กับพนักงานผ่านคอลัมน์ `Email` ใน Outsource tab (หรือคอลัมน์ `EmpID` ใน Users tab)
- อนุมัติคำขอของตัวเองไม่ได้ · เวลา punch มาจากนาฬิกา server เสมอ (browser แก้ไม่ได้)

### 8.3 Logic สำคัญ
- **สาย:** เข้าช้ากว่ากะใน roster เกิน 15 นาที → ธง `LATE` (แก้ได้ที่ `ATT.LATE_GRACE_MIN`)
- **OT:** ชม.ทำงานจริงที่เกินความยาวกะ ปัดลงทีละ 30 นาที; ถ้าเกินจำนวนที่อนุมัติ → ธง `OT_UNAPPROVED`
- **กะข้ามคืน:** เช็คเอาท์เวลาน้อยกว่าเช็คอิน → ระบบตีเป็นวันถัดไปให้เอง
- **อนุมัติลา:** เขียนรหัสลา (SL/BL/AL/Vac) ลง roster ทุกวันในช่วงที่ขอ — Monthly Roster / Daily Ops เห็นทันที; ถ้ากลับคำอนุมัติหรือยกเลิก ระบบคืนรหัสกะเดิมให้

### 8.4 Import ไฟล์ Vendor
หน้า **Check-In / Out → ทะเบียน Outsource → 📥 Import ไฟล์ Vendor** รองรับไฟล์รายงานส่งแรงงานรายเดือน
(เช่น `Jan - May 2026Globex.xlsx`): บล็อกละคน (กะการทำงาน / OT1.5 / OT1 / OT3), กะแบบช่วงเวลา `08-17`,
ปี พ.ศ. → ค.ศ. อัตโนมัติ. ระบบลงทะเบียนพนักงาน + เขียนกะลง roster ให้.
> ไฟล์ `.xlsx` ต้องเปิดใน Google Sheets แล้ว **File → Save as Google Sheets** ก่อน (หรือเปิด Advanced Drive Service ใน Apps Script เพื่อให้แปลงอัตโนมัติ)

### 8.5 ทดสอบ
รันใน Apps Script editor: `TEST_attBootstrap`, `TEST_outsource`, `TEST_attendance`, `TEST_requests`, `TEST_attSummary`
