/**
 * PSA-HKT Assignment Bridge — Apps Script Web App
 * ─────────────────────────────────────────────────────────────────────
 * Reads Staff + Flights from Google Sheets, writes Assignments back,
 * with Workspace SSO auth, LockService for concurrency, audit logging.
 *
 * DEPLOY:
 *   1. drive.google.com → New → More → Google Apps Script (standalone)
 *   2. Paste this whole file → save
 *   3. Set the IDs in CONFIG below
 *   4. Deploy → New deployment → Web app
 *        Execute as:      User accessing the web app   (NOT "Me"!)
 *        Who has access:  Anyone within aotga.com
 *   5. Copy URL → paste into PSA-HKT-LIVE.html Sync field (no token needed)
 *
 * AUTH MODEL:
 *   • User opens HTML → browser is signed in to Google Workspace
 *   • All fetch() to this script carry the user's identity automatically
 *   • Session.getActiveUser().getEmail() returns the real caller
 *   • Users tab (in Master) gates who can WRITE
 *   • Reads are open to anyone in the domain
 */

// ───────────────────────────────────────────────────────────────────────
// CONFIG — edit these IDs once after setup
// ───────────────────────────────────────────────────────────────────────
var CFG = {
  // Pax Manpower = Staff master (same file). Has tabs: Total, Users, BotConfig, Logs, Roster
  STAFF_FILE_ID:      '1oqKI1lbXDow6JCHCOqRIhT7o7dI9U9zfpyV8CJGOUJ8',
  MASTER_FILE_ID:     '1oqKI1lbXDow6JCHCOqRIhT7o7dI9U9zfpyV8CJGOUJ8',
  FLIGHT_FILE_ID:     '1Y3ft-vkHQ5Rm2LVmq1Zz_2j8n5T8wLgCJtdBKhqfBAA',
  ASSIGNMENT_FILE_ID: '1UDfFDWDihh71c_mNuZ96xAeGGZqKbL-ITFHx8eh7PMA',

  STAFF_TAB:        'Total',    // staff master tab inside Pax Manpower file
  FLIGHT_TAB:       '',         // empty = first tab of Flight file
  USERS_TAB:        'Users',
  LOGS_TAB:         'Logs',
  ROSTER_FILE_ID:   '1MEm0zlu-nlf396ISigHurgxUKr_X_V8IaNzQOWr_zgA',  // dedicated roster spreadsheet (app DB, separate from Pax Manpower)
  ROSTER_TAB:       'Roster',   // tab name inside the roster spreadsheet
  ROSTER_SRC_FILE_ID: '1acD7TSmlSdd-MjT3gqYkP6C-SW4JkqEXIRk74JhhHKU',  // the REAL manual monthly roster (read-only source)
  LL_SRC_FILE_ID:   '1w3UPzG3j6SNgsfxszTdMet_I4gSC2ZD37LE_lGAkVcw',  // LL (baggage-tracing) daily-assignment workbook in Drive
  ASSIGN_FOLDER_ID: '1qV5UWoAS6MSkEGm6bVDyCpYLwqugLc0o',  // daily Assignment workbooks (per day 01MAY..31MAY) — MANPOWER tab reads OT
  DATE_TAB_FORMAT:  'ddMMM',    // e.g. 13MAY  — matches BotConfig in Pax Manpower

  ASSIGNMENT_HEADERS: ['Date','Team','Flight','FI','Role','Slot','EmpID','EmpName','At','By'],

  // Roles eligible to assign (everyone else is read-only). Empty = open to whole Users tab.
  ALLOWED_WRITERS:  []          // e.g. ['hansa.sr@aotga.com', 'sup-team@aotga.com']
};

// ───────────────────────────────────────────────────────────────────────
// SLA DATABASE — 60+ airlines · ported from PSA-HKT-LIVE.html
//   ci = check-in OPEN min before STD (negative)
//   cc = check-in CLOSE min before STD (negative)
//   go = gate-monitor OPEN min before STD
//   brief = briefing min before ci-open
//   post  = post-flight min after STD
//   roles[i] = [label, count, jobCode, area]   area ∈ ALL/CI/GATE/ARR
// ───────────────────────────────────────────────────────────────────────
var SLA = {
  'QR':  {ci:-240,cc:-45,go:-75,brief:60,post:30,total:20,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',11,'CT/G','CI'],['ARRIVAL',3,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'MH':  {ci:-240,cc:-60,go:-75,brief:60,post:30,total:9, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',2,'GA','GATE']]},
  'DE':  {ci:-240,cc:-45,go:-75,brief:60,post:30,total:12,roles:[['SUPERVISOR',2,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'OM':  {ci:-240,cc:-45,go:-75,brief:60,post:30,total:12,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'EY':  {ci:-180,cc:-60,go:-60,brief:60,post:30,total:12,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',9,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',0,'GA','GATE']]},
  'AY':  {ci:-180,cc:-45,go:-60,brief:60,post:30,total:13,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'DV':  {ci:-180,cc:-40,go:-60,brief:10,post:30,total:12,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'SQ':  {ci:-240,cc:-40,go:-75,brief:60,post:30,total:13,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'CX':  {ci:-240,cc:-60,go:-60,brief:60,post:30,total:15,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',5,'GA','GATE']]},
  'LY':  {ci:-240,cc:-60,go:-75,brief:60,post:30,total:16,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',8,'CT/G','CI'],['ARRIVAL',3,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'SU':  {ci:-180,cc:-40,go:15, brief:60,post:30,total:23,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',16,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'W5':  {ci:-180,cc:-60,go:-120,brief:60,post:30,total:15,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',7,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'B2':  {ci:-180,cc:-40,go:15, brief:60,post:30,total:13,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'AK':  {ci:-180,cc:-60,go:-50,brief:15,post:30,total:9, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',3,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'QZ':  {ci:-180,cc:-60,go:-50,brief:15,post:30,total:9, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',3,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  '8M':  {ci:-180,cc:-60,go:-60,brief:15,post:30,total:8, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',3,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',2,'GA','GATE']]},
  'PG':  {ci:-180,cc:-40,go:-45,brief:30,post:20,total:7,roles:[['SUPERVISOR',1,'SUP','ALL'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'KE':  {ci:-240,cc:-60,go:-75,brief:60,post:30,total:16,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',8,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'OZ':  {ci:-180,cc:-60,go:-60,brief:60,post:30,total:14,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',7,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'KC':  {ci:-180,cc:-60,go:-60,brief:60,post:30,total:12,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'NO':  {ci:-180,cc:-60,go:-60,brief:45,post:30,total:14,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'AF':  {ci:-180,cc:-60,go:-60,brief:45,post:30,total:14,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'LJ':  {ci:-180,cc:-60,go:-60,brief:45,post:30,total:14,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'OV':  {ci:-180,cc:-60,go:-60,brief:45,post:30,total:14,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'EK':  {ci:-240,cc:-60,go:-60,brief:60,post:30,total:17,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',4,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',5,'GA','GATE']]},
  'UO':  {ci:-180,cc:-60,go:-60,brief:30,post:30,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'BY':  {ci:-180,cc:-60,go:-60,brief:30,post:30,total:13,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'FY':  {ci:-160,cc:-60,go:-60,brief:30,post:30,total:9, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',3,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  '6B':  {ci:-180,cc:-60,go:-60,brief:30,post:30,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'WY':  {ci:-180,cc:-60,go:-45,brief:20,post:20,total:13,roles:[['SUPERVISOR',2,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'G9':  {ci:-180,cc:-75,go:-60,brief:20,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'DK':  {ci:-180,cc:-75,go:-60,brief:30,post:20,total:13,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',5,'GA','GATE']]},
  '9C':  {ci:-180,cc:-60,go:-60,brief:30,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'TK':  {ci:-180,cc:-60,go:-60,brief:60,post:30,total:18,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',8,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',6,'GA','GATE']]},
  'VJ':  {ci:-180,cc:-50,go:-60,brief:30,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'SG':  {ci:-180,cc:-60,go:-50,brief:30,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'HY':  {ci:-180,cc:-60,go:-100,brief:30,post:20,total:12,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'OD':  {ci:-180,cc:-60,go:-60,brief:30,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'TR':  {ci:-150,cc:-60,go:-45,brief:30,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  '6E':  {ci:-180,cc:-75,go:-60,brief:15,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'QP':  {ci:-195,cc:-60,go:-75,brief:30,post:20,total:12,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'SV':  {ci:-240,cc:-60,go:-60,brief:30,post:30,total:16,roles:[['SUPERVISOR',2,'SUP','ALL'],['CHECK-IN',7,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'WK':  {ci:-210,cc:-60,go:-60,brief:60,post:30,total:15,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',7,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'KA':  {ci:-180,cc:-60,go:-60,brief:30,post:30,total:14,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  '3U':  {ci:-180,cc:-60,go:-60,brief:15,post:30,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'CA':  {ci:-180,cc:-40,go:-60,brief:15,post:30,total:13,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'CZ':  {ci:-180,cc:-45,go:-70,brief:15,post:30,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'MU':  {ci:-180,cc:-60,go:-60,brief:10,post:30,total:12,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'FM':  {ci:-180,cc:-60,go:-60,brief:10,post:30,total:12,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'HO':  {ci:-180,cc:-60,go:-60,brief:15,post:30,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'HU':  {ci:-180,cc:-60,go:-60,brief:15,post:30,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'AQ':  {ci:-180,cc:-60,go:-60,brief:15,post:30,total:10,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'HX':  {ci:-240,cc:-60,go:-60,brief:15,post:30,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'AI':  {ci:-195,cc:-60,go:-70,brief:15,post:20,total:13,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',2,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'IX':  {ci:-180,cc:-60,go:-75,brief:15,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'JQ':  {ci:-180,cc:-60,go:-90,brief:45,post:20,total:17,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',7,'CT/G','CI'],['ARRIVAL',3,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',5,'GA','GATE']]},
  'IT':  {ci:-180,cc:-45,go:-60,brief:30,post:20,total:10,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',0,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',4,'GA','GATE']]},
  'N0':  {ci:-240,cc:-60,go:-135,brief:60,post:20,total:14,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',6,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',5,'GA','GATE']]},
  'PVT':     {ci:-60, cc:-20,go:-20,brief:20,post:20,total:2, roles:[['SUPERVISOR',1,'SUP','ALL'],['GATE AGENT',1,'GA','GATE']]},
  'CHARTER': {ci:-120,cc:-30,go:-30,brief:30,post:20,total:5, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',2,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE AGENT',1,'GA','GATE']]},
  'ZF':      {ci:-180,cc:-45,go:-45,brief:30,post:20,total:10,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',2,'GA','GATE']]},
  'HH':      {ci:-180,cc:-45,go:-45,brief:30,post:20,total:9, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',2,'GA','GATE']]},
  'LO':      {ci:-180,cc:-45,go:-45,brief:30,post:20,total:9, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',2,'GA','GATE']]},
  'EO':      {ci:-180,cc:-45,go:-45,brief:30,post:20,total:9, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',2,'GA','GATE']]},
  'S7':      {ci:-180,cc:-45,go:-45,brief:30,post:20,total:11,roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',5,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',3,'GA','GATE']]},
  'DEFAULT': {ci:-180,cc:-45,go:-45,brief:60,post:20,total:8, roles:[['SUPERVISOR',1,'SUP','ALL'],['CHECK-IN',4,'CT/G','CI'],['ARRIVAL',1,'ARR','ARR'],['GATE MONITOR',1,'GM','GATE'],['GATE AGENT',1,'GA','GATE']]}
};
function getSLAraw(airline){ return SLA[airline] || SLA['DEFAULT']; }
// SLA roles are the TRUE required headcount, gate included. Whether one
// person works check-in only, gate only, or CT/G (both) is decided at
// assignment time by autoAssignDay based on how many team staff remain —
// NOT by pre-dropping gate here. Kept as an identity passthrough so every
// caller (gap/coverage/support/auto) sees the real role set.
function slaEffective(sla){ return sla; }
function _hasCTG(sla){
  return !!(sla && sla.roles && sla.roles.some(function(r){
    return arBaseCode(r.length>=3?r[2]:r[0])==='CT/G';
  }));
}
function _isGateCode(code){ var b=arBaseCode(code); return b==='GA'||b==='GATE'; }
function getSLA(airline){ return slaEffective(getSLAraw(airline)); }


// ── Shift roster parsing (mirrors Index.html lookupShift/arShiftWindow) ──
// Server must reject OFF/LEAVE/not-on-shift staff in autoAssignDay; the
// client already does this via shiftOK — keep them byte-identical.
var SHIFT_DB = {"shifts":{"A10":{"i":"01:00","o":"11:00","h":10},"A11":{"i":"01:00","o":"12:00","h":11},"A12":{"i":"01:00","o":"13:00","h":12},"A4":{"i":"01:00","o":"05:00","h":4},"A5":{"i":"01:00","o":"06:00","h":5},"A6":{"i":"01:00","o":"07:00","h":6},"A7":{"i":"01:00","o":"08:00","h":7},"A8":{"i":"01:00","o":"09:00","h":8},"A9":{"i":"01:00","o":"10:00","h":9},"AAO":{"i":"01:30","o":"11:30","h":10},"AA1":{"i":"01:30","o":"12:30","h":11},"AA2":{"i":"01:30","o":"13:30","h":12},"AA9":{"i":"01:30","o":"10:30","h":9},"B10":{"i":"02:00","o":"12:00","h":10},"B11":{"i":"02:00","o":"13:00","h":11},"B12":{"i":"02:00","o":"14:00","h":12},"B4":{"i":"02:00","o":"06:00","h":4},"B5":{"i":"02:00","o":"07:00","h":5},"B6":{"i":"02:00","o":"08:00","h":6},"B7":{"i":"02:00","o":"09:00","h":7},"B8":{"i":"02:00","o":"10:00","h":8},"B9":{"i":"02:00","o":"11:00","h":9},"BBO":{"i":"02:30","o":"12:30","h":10},"BB1":{"i":"02:30","o":"13:30","h":11},"BB2":{"i":"02:30","o":"14:30","h":12},"BB9":{"i":"02:30","o":"11:30","h":9},"C10":{"i":"03:00","o":"13:00","h":10},"C11":{"i":"03:00","o":"14:00","h":11},"C12":{"i":"03:00","o":"15:00","h":12},"C4":{"i":"03:00","o":"07:00","h":4},"C5":{"i":"03:00","o":"08:00","h":5},"C6":{"i":"03:00","o":"09:00","h":6},"C7":{"i":"03:00","o":"10:00","h":7},"C8":{"i":"03:00","o":"11:00","h":8},"C9":{"i":"03:00","o":"12:00","h":9},"CCO":{"i":"03:30","o":"13:30","h":10},"CC1":{"i":"03:30","o":"14:30","h":11},"CC2":{"i":"03:30","o":"15:30","h":12},"CC9":{"i":"03:30","o":"12:30","h":9},"D10":{"i":"04:00","o":"14:00","h":10},"D11":{"i":"04:00","o":"15:00","h":11},"D12":{"i":"04:00","o":"16:00","h":12},"D4":{"i":"04:00","o":"08:00","h":4},"D5":{"i":"04:00","o":"09:00","h":5},"D6":{"i":"04:00","o":"10:00","h":6},"D7":{"i":"04:00","o":"11:00","h":7},"D8":{"i":"04:00","o":"12:00","h":8},"D9":{"i":"04:00","o":"13:00","h":9},"DDO":{"i":"04:30","o":"14:30","h":10},"DD1":{"i":"04:30","o":"15:30","h":11},"DD2":{"i":"04:30","o":"16:30","h":12},"DD5":{"i":"04:30","o":"09:30","h":5},"DD6":{"i":"04:30","o":"10:30","h":6},"DD8":{"i":"04:30","o":"12:30","h":8},"DD9":{"i":"04:30","o":"13:30","h":9},"E10":{"i":"05:00","o":"15:00","h":10},"E11":{"i":"05:00","o":"16:00","h":11},"E12":{"i":"05:00","o":"17:00","h":12},"E4":{"i":"05:00","o":"09:00","h":4},"E5":{"i":"05:00","o":"10:00","h":5},"E6":{"i":"05:00","o":"11:00","h":6},"E7":{"i":"05:00","o":"12:00","h":7},"E8":{"i":"05:00","o":"13:00","h":8},"E9":{"i":"05:00","o":"14:00","h":9},"EEO":{"i":"05:30","o":"15:30","h":10},"EE1":{"i":"05:30","o":"16:30","h":11},"EE2":{"i":"05:30","o":"17:30","h":12},"EE4":{"i":"05:30","o":"09:30","h":4},"EES":{"i":"05:30","o":"10:30","h":5},"EE6":{"i":"05:30","o":"11:30","h":6},"EE7":{"i":"05:30","o":"12:30","h":7},"EE8":{"i":"05:30","o":"13:30","h":8},"EE9":{"i":"05:30","o":"14:30","h":9},"F10":{"i":"06:00","o":"16:00","h":10},"F11":{"i":"06:00","o":"17:00","h":11},"F12":{"i":"06:00","o":"18:00","h":12},"F4":{"i":"06:00","o":"10:00","h":4},"F5":{"i":"06:00","o":"11:00","h":5},"F6":{"i":"06:00","o":"12:00","h":6},"F7":{"i":"06:00","o":"13:00","h":7},"F8":{"i":"06:00","o":"14:00","h":8},"F9":{"i":"06:00","o":"15:00","h":9},"FFO":{"i":"06:30","o":"16:30","h":10},"FF1":{"i":"06:30","o":"17:30","h":11},"FF2":{"i":"06:30","o":"18:30","h":12},"FF6":{"i":"06:30","o":"12:30","h":6},"FF8":{"i":"06:30","o":"14:30","h":8},"FF9":{"i":"06:30","o":"15:30","h":9},"G10":{"i":"07:00","o":"17:00","h":10},"G11":{"i":"07:00","o":"18:00","h":11},"G12":{"i":"07:00","o":"19:00","h":12},"G4":{"i":"07:00","o":"11:00","h":4},"G5":{"i":"07:00","o":"12:00","h":5},"G6":{"i":"07:00","o":"13:00","h":6},"G7":{"i":"07:00","o":"14:00","h":7},"G8":{"i":"07:00","o":"15:00","h":8},"G9":{"i":"07:00","o":"16:00","h":9},"GGO":{"i":"07:30","o":"17:30","h":10},"GG1":{"i":"07:30","o":"18:30","h":11},"GG2":{"i":"07:30","o":"19:30","h":12},"GG6":{"i":"07:30","o":"13:30","h":6},"GG7":{"i":"07:30","o":"14:30","h":7},"GG8":{"i":"07:30","o":"15:30","h":8},"GG9":{"i":"07:30","o":"16:30","h":9},"H10":{"i":"08:00","o":"18:00","h":10},"H11":{"i":"08:00","o":"19:00","h":11},"H12":{"i":"08:00","o":"20:00","h":12},"H4":{"i":"08:00","o":"12:00","h":4},"H5":{"i":"08:00","o":"13:00","h":5},"H6":{"i":"08:00","o":"14:00","h":6},"H7":{"i":"08:00","o":"15:00","h":7},"H8":{"i":"08:00","o":"16:00","h":8},"H9":{"i":"08:00","o":"17:00","h":9},"HHO":{"i":"08:30","o":"18:30","h":10},"HH1":{"i":"08:30","o":"19:30","h":11},"HH2":{"i":"08:30","o":"20:30","h":12},"HH3":{"i":"08:30","o":"20:00","h":11.5},"HH5":{"i":"08:30","o":"13:30","h":5},"HH6":{"i":"08:30","o":"14:30","h":6},"HH7":{"i":"08:30","o":"15:30","h":7},"HH8":{"i":"08:30","o":"16:30","h":8},"HH9":{"i":"08:30","o":"17:30","h":9},"HQ9":{"i":"08:00","o":"17:00","h":8},"I10":{"i":"09:00","o":"19:00","h":10},"I11":{"i":"09:00","o":"20:00","h":11},"I12":{"i":"09:00","o":"21:00","h":12},"I4":{"i":"09:00","o":"13:00","h":4},"I5":{"i":"09:00","o":"14:00","h":5},"I6":{"i":"09:00","o":"15:00","h":6},"I7":{"i":"09:00","o":"16:00","h":7},"I8":{"i":"09:00","o":"17:00","h":8},"I9":{"i":"09:00","o":"18:00","h":9},"II0":{"i":"09:30","o":"19:30","h":10},"II2":{"i":"09:30","o":"21:30","h":12},"II6":{"i":"09:30","o":"20:30","h":11},"II9":{"i":"09:30","o":"18:30","h":9},"J10":{"i":"10:00","o":"20:00","h":10},"J11":{"i":"10:00","o":"21:00","h":11},"J12":{"i":"10:00","o":"22:00","h":12},"J4":{"i":"10:00","o":"14:00","h":4},"J5":{"i":"10:00","o":"15:00","h":5},"J6":{"i":"10:00","o":"16:00","h":6},"J7":{"i":"10:00","o":"17:00","h":7},"J8":{"i":"10:00","o":"18:00","h":8},"J9":{"i":"10:00","o":"19:00","h":9},"JJ0":{"i":"10:30","o":"20:30","h":10},"JJ1":{"i":"10:30","o":"21:30","h":11},"JJ2":{"i":"10:30","o":"22:30","h":12},"JJ9":{"i":"10:30","o":"19:30","h":9},"K10":{"i":"11:00","o":"21:00","h":10},"K11":{"i":"11:00","o":"22:00","h":11},"K12":{"i":"11:00","o":"23:00","h":12},"K4":{"i":"11:00","o":"15:00","h":4},"K5":{"i":"11:00","o":"16:00","h":5},"K6":{"i":"11:00","o":"17:00","h":6},"K7":{"i":"11:00","o":"18:00","h":7},"K8":{"i":"11:00","o":"19:00","h":8},"K9":{"i":"11:00","o":"20:00","h":9},"KKO":{"i":"11:30","o":"21:30","h":10},"KK1":{"i":"11:30","o":"22:30","h":11},"KK2":{"i":"11:30","o":"23:30","h":12},"KK5":{"i":"11:30","o":"16:30","h":5},"KK9":{"i":"11:30","o":"20:30","h":9},"L10":{"i":"12:00","o":"22:00","h":10},"L11":{"i":"12:00","o":"23:00","h":11},"L12":{"i":"12:00","o":"00:00","h":12},"L4":{"i":"12:00","o":"16:00","h":4},"L5":{"i":"12:00","o":"17:00","h":5},"L6":{"i":"12:00","o":"18:00","h":6},"L7":{"i":"12:00","o":"19:00","h":7},"L8":{"i":"12:00","o":"20:00","h":8},"L9":{"i":"12:00","o":"21:00","h":9},"LLO":{"i":"12:30","o":"22:30","h":10},"LL1":{"i":"12:30","o":"23:30","h":11},"LL2":{"i":"12:30","o":"00:30","h":12},"LL9":{"i":"12:30","o":"21:30","h":9},"M10":{"i":"13:00","o":"23:00","h":10},"M11":{"i":"13:00","o":"00:00","h":11},"M12":{"i":"13:00","o":"01:00","h":12},"M4":{"i":"13:00","o":"17:00","h":4},"M5":{"i":"13:00","o":"18:00","h":5},"M6":{"i":"13:00","o":"19:00","h":6},"M7":{"i":"13:00","o":"20:00","h":7},"M8":{"i":"13:00","o":"21:00","h":8},"M9":{"i":"13:00","o":"22:00","h":9},"MMO":{"i":"13:30","o":"23:30","h":10},"MM1":{"i":"13:30","o":"00:30","h":11},"MM2":{"i":"13:30","o":"01:30","h":12},"MM7":{"i":"13:30","o":"20:30","h":7},"MM9":{"i":"13:30","o":"22:30","h":9},"N10":{"i":"14:00","o":"00:00","h":10},"N11":{"i":"14:00","o":"01:00","h":11},"N12":{"i":"14:00","o":"02:00","h":12},"N4":{"i":"14:00","o":"18:00","h":4},"N5":{"i":"14:00","o":"19:00","h":5},"N6":{"i":"14:00","o":"20:00","h":6},"N7":{"i":"14:00","o":"21:00","h":7},"N8":{"i":"14:00","o":"22:00","h":8},"N9":{"i":"14:00","o":"23:00","h":9},"NNO":{"i":"14:30","o":"00:30","h":10},"NN1":{"i":"14:30","o":"01:30","h":11},"NN2":{"i":"14:30","o":"02:30","h":12},"NN8":{"i":"14:30","o":"22:30","h":8},"NN9":{"i":"14:30","o":"23:30","h":9},"O10":{"i":"15:00","o":"01:00","h":10},"O11":{"i":"15:00","o":"02:00","h":11},"O12":{"i":"15:00","o":"03:00","h":12},"O4":{"i":"15:00","o":"19:00","h":4},"O5":{"i":"15:00","o":"20:00","h":5},"O6":{"i":"15:00","o":"21:00","h":6},"O7":{"i":"15:00","o":"22:00","h":7},"O8":{"i":"15:00","o":"23:00","h":8},"O9":{"i":"15:00","o":"00:00","h":9},"OOO":{"i":"15:30","o":"01:30","h":10},"OO1":{"i":"15:30","o":"02:30","h":11},"OO2":{"i":"15:30","o":"03:30","h":12},"OO9":{"i":"15:30","o":"00:30","h":9},"OPS":{"i":"08:00","o":"17:00","h":8},"P10":{"i":"16:00","o":"02:00","h":10},"P11":{"i":"16:00","o":"03:00","h":11},"P12":{"i":"16:00","o":"04:00","h":12},"P4":{"i":"16:00","o":"20:00","h":4},"P5":{"i":"16:00","o":"21:00","h":5},"P6":{"i":"16:00","o":"22:00","h":6},"P7":{"i":"16:00","o":"23:00","h":7},"P8":{"i":"16:00","o":"00:00","h":8},"P9":{"i":"16:00","o":"01:00","h":9},"PPO":{"i":"16:30","o":"02:30","h":10},"PP1":{"i":"16:30","o":"03:30","h":11},"PP2":{"i":"16:30","o":"04:30","h":12},"PP8":{"i":"16:30","o":"00:30","h":8},"PP9":{"i":"16:30","o":"01:30","h":9},"Q10":{"i":"17:00","o":"03:00","h":10},"Q11":{"i":"17:00","o":"04:00","h":11},"Q12":{"i":"17:00","o":"05:00","h":12},"Q4":{"i":"17:00","o":"21:00","h":4},"Q5":{"i":"17:00","o":"22:00","h":5},"Q6":{"i":"17:00","o":"23:00","h":6},"Q7":{"i":"17:00","o":"00:00","h":7},"Q8":{"i":"17:00","o":"01:00","h":8},"Q9":{"i":"17:00","o":"02:00","h":9},"QQO":{"i":"17:30","o":"03:30","h":10},"QQ1":{"i":"17:30","o":"04:30","h":11},"QQ2":{"i":"17:30","o":"05:30","h":12},"QQ9":{"i":"17:30","o":"02:30","h":9},"R10":{"i":"18:00","o":"04:00","h":10},"R11":{"i":"18:00","o":"05:00","h":10},"R12":{"i":"18:00","o":"06:00","h":12},"R4":{"i":"18:00","o":"22:00","h":4},"R5":{"i":"18:00","o":"23:00","h":5},"R6":{"i":"18:00","o":"00:00","h":6},"R7":{"i":"18:00","o":"01:00","h":7},"R8":{"i":"18:00","o":"02:00","h":8},"R9":{"i":"18:00","o":"03:00","h":9},"RRO":{"i":"18:30","o":"04:30","h":10},"RR1":{"i":"18:30","o":"05:30","h":11},"RR2":{"i":"18:30","o":"06:30","h":12},"RR9":{"i":"18:30","o":"03:30","h":9},"S10":{"i":"19:00","o":"05:00","h":10},"S11":{"i":"19:00","o":"06:00","h":11},"S12":{"i":"19:00","o":"07:00","h":12},"S4":{"i":"19:00","o":"23:00","h":4},"S5":{"i":"19:00","o":"00:00","h":5},"S6":{"i":"19:00","o":"01:00","h":6},"S7":{"i":"19:00","o":"02:00","h":7},"S8":{"i":"19:00","o":"03:00","h":8},"S9":{"i":"19:00","o":"04:00","h":9},"SSO":{"i":"19:30","o":"05:30","h":10},"SS1":{"i":"19:30","o":"06:30","h":11},"SS2":{"i":"19:30","o":"07:30","h":12},"SS9":{"i":"19:30","o":"04:30","h":9},"T10":{"i":"20:00","o":"06:00","h":10},"T11":{"i":"20:00","o":"07:00","h":11},"T12":{"i":"20:00","o":"08:00","h":12},"T4":{"i":"20:00","o":"00:00","h":4},"T5":{"i":"20:00","o":"01:00","h":5},"T6":{"i":"20:00","o":"02:00","h":6},"T7":{"i":"20:00","o":"03:00","h":7},"T8":{"i":"20:00","o":"04:00","h":8},"T9":{"i":"20:00","o":"05:00","h":9},"TTO":{"i":"20:30","o":"06:30","h":10},"TT1":{"i":"20:30","o":"07:30","h":11},"TT2":{"i":"20:30","o":"08:30","h":12},"TT9":{"i":"20:30","o":"05:30","h":9},"U10":{"i":"21:00","o":"07:00","h":10},"U11":{"i":"21:00","o":"08:00","h":11},"U12":{"i":"21:00","o":"09:00","h":12},"U4":{"i":"21:00","o":"01:00","h":4},"U5":{"i":"21:00","o":"02:00","h":5},"U6":{"i":"21:00","o":"03:00","h":6},"U7":{"i":"21:00","o":"04:00","h":7},"U8":{"i":"21:00","o":"05:00","h":8},"U9":{"i":"21:00","o":"06:00","h":9},"UUO":{"i":"21:30","o":"07:30","h":10},"UU1":{"i":"21:30","o":"08:30","h":11},"UU2":{"i":"21:30","o":"09:30","h":12},"UU9":{"i":"21:30","o":"06:30","h":9},"V10":{"i":"22:00","o":"08:00","h":10},"V11":{"i":"22:00","o":"09:00","h":11},"V12":{"i":"22:00","o":"10:00","h":12},"V4":{"i":"22:00","o":"02:00","h":4},"V5":{"i":"22:00","o":"03:00","h":5},"V6":{"i":"22:00","o":"04:00","h":6},"V7":{"i":"22:00","o":"05:00","h":7},"V8":{"i":"22:00","o":"06:00","h":8},"V9":{"i":"22:00","o":"07:00","h":9},"WO":{"i":"22:30","o":"08:30","h":10},"VV1":{"i":"22:30","o":"09:30","h":11},"VV2":{"i":"22:30","o":"10:30","h":12},"VV9":{"i":"22:30","o":"07:30","h":9},"W10":{"i":"23:00","o":"09:00","h":10},"W11":{"i":"23:00","o":"10:00","h":11},"W12":{"i":"23:00","o":"11:00","h":12},"W4":{"i":"23:00","o":"03:00","h":4},"W5":{"i":"23:00","o":"04:00","h":5},"W6":{"i":"23:00","o":"05:00","h":6},"W7":{"i":"23:00","o":"06:00","h":7},"W8":{"i":"23:00","o":"07:00","h":8},"W9":{"i":"23:00","o":"08:00","h":9},"WWO":{"i":"23:30","o":"09:30","h":10},"WW1":{"i":"23:30","o":"10:30","h":11},"WW2":{"i":"23:30","o":"11:30","h":12},"WW9":{"i":"23:30","o":"08:30","h":9},"X10":{"i":"00:00","o":"10:00","h":10},"X11":{"i":"00:00","o":"11:00","h":11},"X12":{"i":"00:00","o":"12:00","h":12},"X4":{"i":"00:00","o":"04:00","h":4},"X5":{"i":"00:00","o":"05:00","h":5},"X6":{"i":"00:00","o":"06:00","h":6},"X7":{"i":"00:00","o":"07:00","h":7},"X8":{"i":"00:00","o":"08:00","h":8},"X9":{"i":"00:00","o":"09:00","h":9},"XXO":{"i":"00:30","o":"10:30","h":10},"XX1":{"i":"00:30","o":"11:30","h":11},"XX2":{"i":"00:30","o":"12:30","h":12},"XX9":{"i":"00:30","o":"09:30","h":9}},"specials":{"X":{"t":"OFF","l":"Off (Day off)"},"XX":{"t":"OT","l":"OT Off"},"SL":{"t":"LEAVE","l":"Sick Leave"},"BL":{"t":"LEAVE","l":"Personal Leave"},"Vac":{"t":"LEAVE","l":"Vacation"},"AL":{"t":"LEAVE","l":"Annual Leave"},"SW":{"t":"SWAP","l":"Shift Swap"},"TRN":{"t":"TRN","l":"Training"}}};
function _lookupShift(code){
  if (!code) return null;
  var s = SHIFT_DB.shifts[code];
  if (s) return {kind:'WORK', in:s.i, out:s.o, hrs:s.h};
  var sp = SHIFT_DB.specials[code];
  if (sp) return {kind:sp.t, in:null, out:null, hrs:0};
  // Time-range / word schedules (LL dept, manual files): "1000-1900",
  // "05-14", OFF/VAC/SICK. Mirrors client lookupShift.
  var up = String(code).trim().toUpperCase();
  if (/^(OFF|DAYOFF|DO|X)$/.test(up)) return {kind:'OFF', in:null, out:null, hrs:0};
  if (/^(VAC|VACATION|SICK|SICKED|SL|BL|AL|LEAVE|MATERNITY|ML)$/.test(up)) return {kind:'LEAVE', in:null, out:null, hrs:0};
  var rng = up.match(/^(\d{1,2})(\d{2})?\s*[-–]\s*(\d{1,2})(\d{2})?$/);
  if (rng){
    var ih=+rng[1], im=rng[2]!=null?+rng[2]:0, oh=+rng[3], om=rng[4]!=null?+rng[4]:0;
    if (ih<=24 && oh<=24 && im<60 && om<60){
      var dur=(oh*60+om)-(ih*60+im); if (dur<=0) dur+=1440;
      function p2x(n){return (n<10?'0':'')+n;}
      return {kind:'WORK', in:p2x(ih%24)+':'+p2x(im), out:p2x(oh%24)+':'+p2x(om), hrs:Math.round(dur/60*10)/10};
    }
  }
  return {kind:'UNKNOWN', in:null, out:null, hrs:0};
}
// Returns {s,e} in minutes-from-midnight (e may exceed 1440 for overnight),
// or null when the staffer is OFF / on leave / has no WORK code that day.
function _shiftWindow(roster, team, iso, empId){
  var bk = team+'-'+iso+'-'+empId;
  var info = _lookupShift(roster[bk]);
  if (!info || info.kind !== 'WORK') return null;
  var si = _parseHHMM(info.in), so = _parseHHMM(info.out);
  if (si == null || so == null) return null;
  if (so <= si) so += 1440;            // overnight shift
  // Per-day OT recorded in the roster (separate keys). null = not set
  // (use generic OT_EXT_MIN); a number incl. 0 = authoritative.
  function otMin(suffix){
    var v = roster[bk+suffix];
    if (v == null || v === '') return null;
    var n = parseFloat(v); return isNaN(n) ? null : Math.max(0,n)*60;
  }
  return {s:si, e:so, hrs:info.hrs, otb:otMin('|OTB'), ota:otMin('|OTA')};
}
// Base shift is 8–12h; OT can be added before the shift starts or after
// it ends, so the window is widened by OT_EXT_MIN each side. The shift
// must FULLY span the flight's [brief,post] (the old ≥60-min-overlap
// escape let an early-shift person staff a late flight). Mirrors client.
var OT_EXT_MIN = 180;
function _shiftCovers(sw, brief, post){
  if (!sw) return false;
  var beforeExt = (sw.otb==null) ? OT_EXT_MIN : sw.otb;
  var afterExt  = (sw.ota==null) ? OT_EXT_MIN : sw.ota;
  return (sw.s - beforeExt) <= brief && (sw.e + afterExt) >= post;
}

// ───────────────────────────────────────────────────────────────────────
// Airline-code → Team mapping (from production)
// ───────────────────────────────────────────────────────────────────────
var AIRLINE_TO_TEAM = (function(){
  var groups = {
    'TR':  ['TR','6E','QP'],
    'QR':  ['QR','MH','DE','OM'],
    'WY':  ['WY','G9','9C','DK'],
    'JQ':  ['AI','IX','JQ','IT'],
    'KC':  ['KC','KE','OZ','NO','AF','LJ','OV'],
    'EY':  ['EY','DV','AY'],
    'CHN': ['CA','3U','MU','FM','HU','HO','HX','AQ','CZ'],
    'PG':  ['PG'],
    'SQ':  ['SQ','CX','LY'],
    'SU':  ['SU','W5','B2'],
    'EK':  ['UO','EK','FY','6B','BY'],
    'ZF':  ['ZF','LO','HH','EO','N4','G2','H4','S7','C6','WZ','HB'],
    'AK':  ['AK','QZ','8M'],
    'TK':  ['OD','VJ','SG','HY','TK','N0'],
    'PVT': ['Private','VIP','LP'],
    'WK':  ['SV','WK','KA']
  };
  var out = {};
  Object.keys(groups).forEach(function(team){
    groups[team].forEach(function(a){ out[a.toUpperCase()] = team; });
  });
  return out;
})();

// Raw `ทีม` string (slash-separated) → canonical team code
// LL/PORTER excluded for now (will add back when LL module is built)
function normalizeTeam(rawTeam) {
  if (!rawTeam) return null;
  var s = String(rawTeam).trim().toUpperCase();
  // direct match against canonical team codes
  var canon = ['TR','QR','WY','JQ','KC','EY','CHN','PG','SQ','SU','EK','ZF','AK','TK','PVT','WK'];
  if (canon.indexOf(s) >= 0) return s;
  if (s === 'CHARTER' || s === 'CHARTER TEAM') return 'CHARTER';
  if (s.indexOf('CHINA') >= 0) return 'CHN';
  // Baggage / Lost & Found → LL department team (before generic admin/porter
  // mappers, so 'PORTER LL' / 'ADMIN LL' route to LL sub-codes below).
  if (s.indexOf('PORTER LL') >= 0) return 'PORTER_LL';
  if (s.indexOf('ADMIN LL')  >= 0) return 'ADMIN_LL';
  if (s === 'LL' || s === 'BSA' || s === 'BSS' || s === 'SBSA'
      || s.indexOf('LOST') >= 0 || s.indexOf('BAGGAGE') >= 0
      || s.indexOf('ติดตามสัมภาระ') >= 0 || s.indexOf('สัมภาระ') >= 0) return 'LL';
  // Porter / admin / office sub-units — keep as distinct teams (per v2.2
  // §3.1) instead of dropping, so OT/staff/reports cover every sub-unit.
  if (s.indexOf('PORTER CREWSIGN') >= 0 || s.indexOf('CREWSIGN') >= 0) return 'PORTER_CW';
  if (s.indexOf('ADMIN PORTER') >= 0) return 'ADMIN_PT';
  if (s.indexOf('ADMIN DOC')   >= 0 || s === 'DOC') return 'ADMIN_DOC';
  if (s.indexOf('ADMIN')   >= 0) return 'ADMIN_DOC';
  if (s.indexOf('PORTER')  >= 0) return 'PORTER';
  if (s === 'OFFICE') return 'OFFICE';
  // Slash-separated: take first airline code, look up team
  var first = s.split(/[\/,]/)[0].trim();
  if (AIRLINE_TO_TEAM[first]) return AIRLINE_TO_TEAM[first];
  return null;
}

// Full position name → SUP / SNR / PSA / null(exclude)
function normalizePosition(rawPos) {
  if (!rawPos) return null;
  var s = String(rawPos).toLowerCase();
  if (s.indexOf('manager') >= 0 || s.indexOf('director') >= 0
      || s.indexOf('assist manager') >= 0 || s.indexOf('assistant manager') >= 0) return null;
  if (s.indexOf('supervisor') >= 0) return 'SUP';
  if (s.indexOf('senior passenger') >= 0 || s.indexOf('senior baggage') >= 0
      || s.indexOf('act. senior') >= 0 || s.indexOf('acting senior') >= 0) return 'SNR';
  if (s.indexOf('agent') >= 0) return 'PSA';
  // Include porter / admin / office staff (mapped as PSA level) so their
  // sub-unit teams (PORTER, PORTER_CW, ADMIN_*, OFFICE) show OT, roster
  // counts and reports instead of staying empty.
  if (s.indexOf('porter') >= 0 || s.indexOf('admin') >= 0
      || s.indexOf('office') >= 0 || s.indexOf('clerk') >= 0) return 'PSA';
  return null;
}

// ───────────────────────────────────────────────────────────────────────
// Entry points
// ───────────────────────────────────────────────────────────────────────
// Page load (no ?action=) serves the app itself via HtmlService, so the
// browser runs it same-origin and google.script.run carries the user's
// identity. ?action=... still returns JSON (ping / whoami / diagnostics).
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var date   = (e && e.parameter && e.parameter.date)   || _todayISO();
  if (!action) {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('PSA-HKT Live')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  try {
    switch (action) {
      case 'ping':        return _json({ok:true, you:_me(), now:new Date().toISOString()});
      case 'whoami':      return _json(_authDiag());
      case 'rosterfile':  return _json(rosterFileInfo());
      case 'staff':       return _json({staff: pullStaff()});
      case 'flights':     return _json({flights: pullFlights(date)});
      case 'assignments': return _json({assignments: pullAssignments(date)});
      case 'outsource':   return _json({outsource: pullOutsource()});
      case 'attendance':  return _json({attendance: pullAttendance(
                            (e.parameter.from || date), (e.parameter.to || e.parameter.from || date))});
      case 'requests':    return _json({requests: pullRequests({
                            type:e.parameter.type, status:e.parameter.status, empId:e.parameter.empId,
                            from:e.parameter.from, to:e.parameter.to})});
      case 'attsummary':  return _json(attendanceSummary(
                            (e.parameter.from || date), (e.parameter.to || date), e.parameter.team));
      case 'bootstrap':   return _json({
        me:          _me(),
        canWrite:    isAuthorized(_me()),
        auth:        _authDiag(),
        staff:       pullStaff(),
        flights:     pullFlights(date),
        assignments: pullAssignments(date),
        teamConfig:  Object.keys(AIRLINE_TO_TEAM).reduce(function(o,k){o[k]=AIRLINE_TO_TEAM[k];return o;},{})
      });
      default: return _json({error:'unknown action: '+action});
    }
  } catch (err) {
    return _json({error: err.message || String(err), stack: err.stack});
  }
}

function doPost(e) {
  var lock = _acquireLock();
  var body, action, actor = _me();
  try {
    body   = JSON.parse(e.postData.contents);
    action = body.action;
    if (!isAuthorized(actor)) {
      return _json({error: 'unauthorized: '+actor+' (not in Users tab or ALLOWED_WRITERS)'});
    }
    if (!lock || !lock.tryLock(8000)) {
      return _json({error: 'busy — another write in progress, retry'});
    }
    var result;
    switch (action) {
      case 'upsertAssignment': result = upsertAssignment(body, actor); break;
      case 'deleteAssignment': result = deleteAssignment(body, actor); break;
      case 'clearDay':         result = clearDay(body, actor); break;
      case 'autoAssignDay':    result = autoAssignDay(body, actor); break;
      case 'punch':            result = punchAttendance(body); break;
      case 'saveAttendance':   result = saveAttendance(body); break;
      case 'submitRequest':    result = submitRequest(body); break;
      case 'decideRequest':    result = decideRequest(body); break;
      case 'cancelRequest':    result = cancelRequest(body); break;
      case 'saveOutsource':    result = saveOutsourceStaff(body); break;
      case 'importOutsource':  result = importOutsourceFromDrive(body); break;
      default: throw new Error('unknown action: '+action);
    }
    _log(actor, action, JSON.stringify(body).slice(0,400));
    return _json(Object.assign({ok:true, by:actor}, result));
  } catch (err) {
    return _json({error: err.message || String(err)});
  } finally {
    try { lock.releaseLock(); } catch(e){}
  }
}

// ───────────────────────────────────────────────────────────────────────
// google.script.run API — called from the served page (same session, so
// _me() resolves and the per-user write gate works). Return plain objects.
// ───────────────────────────────────────────────────────────────────────
function bootstrapData(date) {
  date = date || _todayISO();
  return {
    me:          _me(),
    canWrite:    isAuthorized(_me()),
    auth:        _authDiag(),
    staff:       pullStaff(),
    flights:     pullFlights(date),
    assignments: pullAssignments(date),
    roster:      pullRoster(),
    teamConfig:  Object.keys(AIRLINE_TO_TEAM).reduce(function(o,k){o[k]=AIRLINE_TO_TEAM[k];return o;},{})
  };
}

function pollAssignments(date) {
  return { assignments: pullAssignments(date || _todayISO()) };
}

// ── Roster store (shift codes) — keyed "TEAM-YYYY-MM-DD-EMPID" → code ──
// Lives in a "Roster" tab of the Pax Manpower file. Lets supervisors
// plan shifts 1–3 months ahead and have it persisted to the database
// immediately, shared across all users (not just localStorage).
// Roster lives in its OWN spreadsheet (not the crowded Pax Manpower file).
// Resolution order: CFG.ROSTER_FILE_ID → ScriptProperties → create a new
// one, share it domain-wide (so every aotga.com user can read/write), and
// remember its id. The created file's URL is exposed via ?action=rosterfile
// and in whoami so the admin can find it.
function _rosterFileId() {
  if (CFG.ROSTER_FILE_ID) return CFG.ROSTER_FILE_ID;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ROSTER_FILE_ID');
  if (id) return id;
  var ss = SpreadsheetApp.create('PSA-HKT Roster DB (auto)');
  id = ss.getId();
  try {
    DriveApp.getFileById(id).setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.EDIT);
  } catch (e) { /* sharing may need manual step — logged below */ }
  props.setProperty('ROSTER_FILE_ID', id);
  _log(_me(), 'createRosterFile', id + ' ' + ss.getUrl());
  return id;
}

function rosterFileInfo() {
  var id = _rosterFileId();
  return { id: id, url: 'https://docs.google.com/spreadsheets/d/' + id + '/edit' };
}

function _getOrCreateRosterSheet() {
  var ss = SpreadsheetApp.openById(_rosterFileId());
  var sh = ss.getSheetByName(CFG.ROSTER_TAB) || ss.getSheets()[0];
  if (!sh || sh.getName() !== CFG.ROSTER_TAB) {
    sh = ss.getSheetByName(CFG.ROSTER_TAB);
    if (!sh) sh = ss.insertSheet(CFG.ROSTER_TAB);
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Key', 'Code', 'At', 'By']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function pullRoster() {
  var sh = _getOrCreateRosterSheet();
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return {};
  var out = {};
  for (var r = 1; r < values.length; r++) {
    var key  = String(values[r][0] || '').trim();
    var code = String(values[r][1] || '').trim();
    if (key && code) out[key] = code;
  }
  return out;
}

// ── Import the REAL manual monthly roster from Drive ──────────────────
// Reads CFG.ROSTER_SRC_FILE_ID (the supervisor-maintained spreadsheet),
// auto-detecting the grid geometry rather than assuming a fixed layout:
//   • a "date header" row = a row with >=4 cells parseable as d/m/yyyy;
//     each such column maps to an ISO date.
//   • the employee-ID column = the column whose cells most often equal a
//     known 6-8 digit staff id (matched against the staff master).
// Team is taken from the staff master by id (the file's own team headers
// are unreliable). Returns {cells:[{key:'TEAM-YYYY-MM-DD-ID', code}], …}
// for the client to merge into state.roster — does NOT write any sheet,
// so it is independent of the roster-save path.
function importRosterFromDrive(body) {
  var srcId = (body && body.fileId) || CFG.ROSTER_SRC_FILE_ID;
  if (!srcId) throw new Error('importRosterFromDrive: no source file id');
  var staff = pullStaff();
  var teamById = {};
  staff.forEach(function(s){ teamById[String(s.i)] = s.t; });

  // Accept "d/m/yyyy" (Thai format, may carry a holiday name), ISO
  // "yyyy-mm-dd", or a real Date value (getDisplayValues usually yields a
  // string, but be defensive).
  function isoFromDMY(v){
    if (v instanceof Date && !isNaN(v)){
      return v.getFullYear()+'-'+(v.getMonth()<9?'0':'')+(v.getMonth()+1)+'-'+(v.getDate()<10?'0':'')+v.getDate();
    }
    var s = String(v);
    var iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso){
      var mo2=+iso[2], d2=+iso[3];
      if (mo2>=1&&mo2<=12&&d2>=1&&d2<=31) return iso[1]+'-'+iso[2]+'-'+iso[3];
    }
    var m = s.match(/(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/);
    if (!m) return null;
    var d=+m[1], mo=+m[2], y=+m[3];
    if (mo<1||mo>12||d<1||d>31) return null;
    return y + '-' + (mo<10?'0':'') + mo + '-' + (d<10?'0':'') + d;
  }
  function normCode(v){
    var c = String(v==null?'':v).trim();
    if (!c) return '';
    c = c.replace(/^\*/,'').toUpperCase();   // *H12 paid-holiday → H12
    return c;
  }

  var ss = SpreadsheetApp.openById(srcId);
  var sheets = ss.getSheets();
  var cells = [], seen = {}, perSheet = [], matched = 0, unmatchedIds = {};

  sheets.forEach(function(sh){
    try {
      // Display values: dates come as the shown text ("1/5/2026"), not a
      // Date object/serial, so the d/m/yyyy detector matches every day
      // column (getValues() returned Dates → only ~5 text cells matched).
      var vals = sh.getDataRange().getDisplayValues();
      if (!vals || vals.length < 2) return;
      var nCols = 0;
      vals.forEach(function(r){ if (r.length>nCols) nCols=r.length; });

      // 1. date-header row + column→ISO map (pick the row with the most dates)
      var bestRow = -1, bestMap = null, bestCount = 0;
      for (var r=0; r<Math.min(vals.length, 20); r++){
        var map = {}, cnt = 0;
        for (var c=0; c<vals[r].length; c++){
          var iso = isoFromDMY(vals[r][c]);
          if (iso){ map[c]=iso; cnt++; }
        }
        if (cnt > bestCount){ bestCount=cnt; bestRow=r; bestMap=map; }
      }
      if (bestRow < 0 || bestCount < 4) return;   // not a roster grid

      // 2. employee-id column = column with most known-staff ids below header
      var idColScore = {};
      for (var rr=bestRow+1; rr<vals.length; rr++){
        for (var cc=0; cc<Math.min(nCols, 8); cc++){
          var idv = String(vals[rr][cc]==null?'':vals[rr][cc]).replace(/\.0$/,'').trim();
          if (/^\d{6,8}$/.test(idv) && teamById[idv]){
            idColScore[cc] = (idColScore[cc]||0)+1;
          }
        }
      }
      var idCol = -1, idBest = 0;
      Object.keys(idColScore).forEach(function(k){ if (idColScore[k]>idBest){ idBest=idColScore[k]; idCol=+k; } });
      if (idCol < 0) return;

      // 3. emit cells
      var rowsHere = 0;
      for (var d=bestRow+1; d<vals.length; d++){
        var row = vals[d];
        var id = String(row[idCol]==null?'':row[idCol]).replace(/\.0$/,'').trim();
        if (!/^\d{6,8}$/.test(id)) continue;
        var team = teamById[id];
        if (!team){ unmatchedIds[id]=1; continue; }
        matched++;
        Object.keys(bestMap).forEach(function(colStr){
          var col = +colStr;
          var code = normCode(row[col]);
          if (!code) return;
          var key = team + '-' + bestMap[col] + '-' + id;
          if (seen[key]) return;            // first sheet wins on conflict
          seen[key] = 1;
          cells.push({ key:key, code:code });
        });
        rowsHere++;
      }
      if (rowsHere) perSheet.push({ sheet:sh.getName(), rows:rowsHere, dates:bestCount });
    } catch (e) {
      perSheet.push({ sheet:sh.getName(), error:String(e && e.message || e) });
    }
  });

  return {
    ok: true,
    fileId: srcId,
    cells: cells,
    n: cells.length,
    staffMatched: matched,
    unmatched: Object.keys(unmatchedIds).length,
    sheets: perSheet
  };
}

// ── Import the LL (baggage-tracing) daily-assignment workbook ─────────
// Different shape from the passenger files: no employee IDs (name + NO
// only), schedule is a time range ("1000-1900"/"OFF"/"VAC"), assignment
// is time-block desk roles not flights. We synthesise a stable LL id
// (LL-001…) from the order names first appear (MASTER sheet preferred),
// key the roster as 'LL-YYYY-MM-DD-LL-NNN', and return the staff roster
// + the desk-assignment marks for the time-block model. Read-only.
function importLLFromDrive(body) {
  var srcId = (body && body.fileId) || CFG.LL_SRC_FILE_ID;
  if (!srcId) throw new Error('importLLFromDrive: no LL file id (set CFG.LL_SRC_FILE_ID or pass fileId)');
  var ss = SpreadsheetApp.openById(srcId);
  var sheets = ss.getSheets();
  var MON = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};

  // Stable id per name, in first-seen order (MASTER sheet first if present)
  var idByName = {}, staff = [], seq = 0;
  function nkey(s){ return String(s||'').trim().toUpperCase().replace(/\s+/g,' '); }
  function idFor(name, pos){
    var k = nkey(name); if (!k) return null;
    if (!idByName[k]){
      seq++;
      var id = 'LL-' + (seq<100?(seq<10?'00':'0'):'') + seq;
      idByName[k] = id;
      staff.push({ i:id, n:String(name).trim(), p:String(pos||'').trim(), t:'LL' });
    }
    return idByName[k];
  }
  function findCols(rows){
    // header row = the one containing NAME + SCHEDULE
    for (var r=0; r<Math.min(rows.length,8); r++){
      var u = rows[r].map(function(c){return String(c==null?'':c).trim().toUpperCase();});
      var ni=u.indexOf('NAME'), si=u.indexOf('SCHEDULE'), pi=u.indexOf('POSITION');
      if (ni>=0 && si>=0) return {hdr:r, name:ni, sched:si, pos:pi};
    }
    return null;
  }

  // Pass 1: seed id order from a master/template sheet if present
  sheets.forEach(function(sh){
    var nm = sh.getName();
    if (!/MASTER|TEMPLATE|NEW/i.test(nm)) return;
    try {
      var rows = sh.getDataRange().getDisplayValues();
      var col = findCols(rows); if (!col) return;
      for (var r=col.hdr+1; r<rows.length; r++){
        var n = rows[r][col.name]; if (n && nkey(n)!=='NAME') idFor(n, col.pos>=0?rows[r][col.pos]:'');
      }
    } catch(e){}
  });

  // Pass 2: per-day sheets → roster cells
  var cells = [], seen = {}, days = [];
  sheets.forEach(function(sh){
    var nm = sh.getName().trim();
    var m = nm.toUpperCase().match(/^(\d{1,2})\s*([A-Z]{3})\s*(\d{2})?/);
    if (!m || !MON[m[2]]) return;                 // not a day sheet
    var dd=+m[1], mo=MON[m[2]], yy=m[3]?2000+(+m[3]):(new Date().getFullYear());
    var iso = yy+'-'+(mo<10?'0':'')+mo+'-'+(dd<10?'0':'')+dd;
    try {
      var rows = sh.getDataRange().getDisplayValues();
      var col = findCols(rows); if (!col) return;
      var nHere = 0;
      for (var r=col.hdr+1; r<rows.length; r++){
        var name = rows[r][col.name];
        if (!name || nkey(name)==='NAME') continue;
        var sched = String(rows[r][col.sched]==null?'':rows[r][col.sched]).trim();
        if (!sched) continue;
        var id = idFor(name, col.pos>=0?rows[r][col.pos]:'');
        if (!id) continue;
        var key = 'LL-' + iso + '-' + id;
        if (seen[key]) continue; seen[key]=1;
        cells.push({ key:key, code:sched });
        nHere++;
      }
      if (nHere) days.push({ sheet:nm, date:iso, rows:nHere });
    } catch(e){ days.push({ sheet:nm, error:String(e && e.message || e) }); }
  });

  return { ok:true, fileId:srcId, team:'LL', staff:staff, cells:cells,
           n:cells.length, staffCount:staff.length, days:days };
}

// ── Read OT per team per day from the daily Assignment workbooks ──────
// Each daily file (name "01MAY26" / "16MAY26") has a MANPOWER tab with
// per-team rows: total staff, on-roster, leaves, training, actual work,
// OT total (excl. holiday), OT holiday (x1). We list the folder, parse
// names → ISO date, filter to [from..to], open MANPOWER, auto-detect
// the header + OT columns, map team labels → canonical team codes
// (via normalizeTeam), aggregate, and return per-team and per-day rows
// + which files we couldn't read. Read-only.
function importManpowerOT(body) {
  var folderId = (body && body.folderId) || CFG.ASSIGN_FOLDER_ID;
  if (!folderId) throw new Error('importManpowerOT: no assignment folder id');
  var from = (body && body.from) ? _toISO(body.from) : '';
  var to   = (body && body.to)   ? _toISO(body.to)   : '';
  var MON = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
  function num(v){
    var s = String(v==null?'':v).trim().replace(/,/g,'');
    if (!s || s==='-' || s==='—') return 0;
    // Excel duration formats — "2 days, 4:30:00" or "1 day, 03:00:00"
    var d = s.match(/(\d+)\s*days?[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
    if (d) return (+d[1])*24 + (+d[2]) + (+d[3])/60 + (d[4]?(+d[4])/3600:0);
    // Bare "HH:MM[:SS]" (more than 24h totals shown as elapsed time)
    var t = s.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
    if (t) return (+t[1]) + (+t[2])/60 + (t[3]?(+t[3])/3600:0);
    var n = parseFloat(s); return isNaN(n) ? 0 : n;
  }
  function mapTeamLabel(label){
    var raw = String(label||'').trim();
    if (!raw) return null;
    if (/^(รวม|TOTAL|GRAND)/i.test(raw)) return null;
    // "Team (EK)" / "Team  (SV/WK)" / "Team ( CHARTER) ไม่รวมGloblex"
    var m = raw.match(/\(\s*([^)]+?)\s*\)/);
    if (m) return normalizeTeam(m[1]) || normalizeTeam(raw);
    return normalizeTeam(raw);
  }

  var folder = DriveApp.getFolderById(folderId);
  var summary = {}, perDay = [], files = [];

  function visit(it){
    while (it.hasNext()){
      var f = it.next();
      var nm = f.getName().trim();
      var dm = nm.toUpperCase().match(/(\d{1,2})\s*([A-Z]{3})\s*(\d{2})?/);
      if (!dm || !MON[dm[2]]) { files.push({name:nm, ok:false, reason:'name'}); continue; }
      var y = dm[3] ? 2000+(+dm[3]) : new Date().getFullYear();
      var iso = y+'-'+_p(MON[dm[2]])+'-'+_p(+dm[1]);
      if (from && iso < from) continue;
      if (to   && iso > to)   continue;
      try {
        var ss = SpreadsheetApp.openById(f.getId());
        var sh = null;
        ss.getSheets().forEach(function(x){ if (!sh && /MANPOWER/i.test(x.getName())) sh = x; });
        if (!sh) { files.push({name:nm, ok:false, date:iso, reason:'no MANPOWER tab'}); continue; }
        var vals = sh.getDataRange().getDisplayValues();
        if (!vals.length) { files.push({name:nm, ok:false, date:iso, reason:'empty'}); continue; }

        // Header row = first row whose first cell looks like ทีม/Team
        var hdr = -1;
        for (var r=0; r<Math.min(vals.length,15); r++){
          var c0 = String(vals[r][0]||'').trim();
          if (/^(ทีม|TEAM)\b/i.test(c0)) { hdr = r; break; }
        }
        if (hdr < 0) { files.push({name:nm, ok:false, date:iso, reason:'no header'}); continue; }

        // OT columns — scan the header row + 3 rows above/below for keywords.
        // The OT-total column header literally says "ไม่รวมโอทีนักขัต X1"
        // (i.e. EXCLUDING holiday OT), so a naive "contains นักขัต → holiday"
        // mis-labels it. Use "ไม่รวม" to flip it back to OT total.
        var span = vals.slice(Math.max(0,hdr-3), Math.min(vals.length,hdr+4));
        var otCol = -1, otHCol = -1;
        for (var c=0; c<vals[hdr].length; c++){
          var concat = span.map(function(rr){return String(rr[c]||'');}).join(' ');
          var lc = concat.toLowerCase();
          var hasOT = (concat.indexOf('โอที')>=0 || /\bot\b/.test(lc) || lc.indexOf('overtime')>=0);
          if (!hasOT) continue;
          var isExclHol = concat.indexOf('ไม่รวม')>=0;
          var isHolOnly = !isExclHol && (concat.indexOf('นักขัต')>=0 || lc.indexOf('x1')>=0 || lc.indexOf('holiday')>=0);
          if (isHolOnly && otHCol < 0) otHCol = c;
          else if (!isHolOnly && otCol < 0) otCol = c;
        }
        // Fallback to observed indices when header text is missing
        if (otCol  < 0) otCol  = 10;
        if (otHCol < 0) otHCol = 11;

        var rowsHere = 0;
        for (var rr=hdr+1; rr<vals.length; rr++){
          var team = mapTeamLabel(vals[rr][0]);
          if (!team) continue;
          var ot  = num(vals[rr][otCol]);
          var oth = num(vals[rr][otHCol]);
          if (ot===0 && oth===0) continue;
          if (!summary[team]) summary[team] = {ot:0, otHol:0, days:0};
          summary[team].ot    += ot;
          summary[team].otHol += oth;
          summary[team].days  += 1;
          perDay.push({team:team, date:iso, ot:ot, otHol:oth});
          rowsHere++;
        }
        files.push({name:nm, date:iso, ok:true, rows:rowsHere});
      } catch(e){
        files.push({name:nm, date:iso, ok:false, reason:String(e && e.message || e)});
      }
    }
  }

  visit(folder.getFilesByType(MimeType.GOOGLE_SHEETS));
  // Some daily files may be uploaded as .xlsx — try those too
  try { visit(folder.getFilesByType(MimeType.MICROSOFT_EXCEL)); } catch(e){}

  return {
    ok: true, folderId: folderId, from: from, to: to,
    summary: summary, perDay: perDay, files: files,
    teams: Object.keys(summary).length, daysCovered: perDay.length
  };
}

// body: { cells: [ {key, code}, ... ] }  — code '' / null = delete the cell
function saveRoster(body) {
  var actor = _me();
  if (!isAuthorized(actor)) throw new Error('unauthorized: ' + actor + ' (not in Users tab or ALLOWED_WRITERS)');
  var cells = (body && body.cells) || [];
  if (!cells.length) return {ok:true, n:0};
  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var sh = _getOrCreateRosterSheet();
    var values = sh.getDataRange().getValues();
    var rowByKey = {}, codeByKey = {};
    for (var r = 1; r < values.length; r++) {
      var k = String(values[r][0] || '').trim();
      if (k) { rowByKey[k] = r + 1; codeByKey[k] = String(values[r][1] || '').trim(); }
    }
    var now = new Date().toISOString();
    var appendRows = [];
    var deleteRows = [];
    var conflicts = [], applied = 0;
    cells.forEach(function(c){
      var key  = String(c.key || '').trim();
      if (!key) return;
      var code = c.code == null ? '' : String(c.code).trim();
      var existing = rowByKey[key];
      var serverCode = existing ? (codeByKey[key] || '') : '';
      // Optimistic concurrency: if the client sent the base it last saw
      // (prev) and the server's current value differs, someone else
      // changed this cell since — reject it and report the live value.
      if (c.prev != null && String(c.prev) !== serverCode) {
        conflicts.push({ key:key, serverCode:serverCode });
        return;
      }
      applied++;
      if (code === '') {
        if (existing) deleteRows.push(existing);
      } else if (existing) {
        sh.getRange(existing, 1, 1, 4).setValues([[key, code, now, actor]]);
      } else {
        appendRows.push([key, code, now, actor]);
      }
    });
    if (appendRows.length) {
      sh.getRange(sh.getLastRow() + 1, 1, appendRows.length, 4).setValues(appendRows);
    }
    // delete bottom-up so row indices stay valid
    deleteRows.sort(function(a,b){return b-a;}).forEach(function(rw){ sh.deleteRow(rw); });
    _log(actor, 'saveRoster', applied + '/' + cells.length + ' cells, ' + conflicts.length + ' conflicts');
    return {ok:true, n:applied, conflicts:conflicts, by:actor};
  } finally { try { lock.releaseLock(); } catch(e){} }
}

function writeAssignment(body) {
  var actor = _me();
  if (!isAuthorized(actor)) throw new Error('unauthorized: ' + actor + ' (not in Users tab or ALLOWED_WRITERS)');
  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var r = upsertAssignment(body, actor);
    _log(actor, 'upsertAssignment', JSON.stringify(body).slice(0,400));
    return Object.assign({ok:true, by:actor}, r);
  } finally { try { lock.releaseLock(); } catch(e){} }
}

function removeAssignment(body) {
  var actor = _me();
  if (!isAuthorized(actor)) throw new Error('unauthorized: ' + actor + ' (not in Users tab or ALLOWED_WRITERS)');
  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var r = deleteAssignment(body, actor);
    _log(actor, 'deleteAssignment', JSON.stringify(body).slice(0,400));
    return Object.assign({ok:true, by:actor}, r);
  } finally { try { lock.releaseLock(); } catch(e){} }
}

// ───────────────────────────────────────────────────────────────────────
// READ — Staff
// ───────────────────────────────────────────────────────────────────────
function pullStaff() {
  var ss = SpreadsheetApp.openById(CFG.STAFF_FILE_ID);
  var sh = CFG.STAFF_TAB ? ss.getSheetByName(CFG.STAFF_TAB) : ss.getSheets()[0];
  if (!sh) throw new Error('Staff tab not found: '+CFG.STAFF_TAB);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  // Find header row in top-3 rows
  var hdrIdx = _findHeaderRow(values, ['รหัสพนักงาน','EmpID','Employee']);
  var headers = values[hdrIdx].map(function(h){return String(h||'').trim();});
  var col = _colMap(headers, {
    id:       ['รหัสพนักงาน','EmpID','Employee ID','ID','รหัส'],
    team:     ['ทีม','Team','สังกัด'],
    pos:      ['ตำแหน่ง','Position','Title-Pos'],
    fname:    ['Name','First Name','ชื่อ(English)','ชื่อ'],
    lname:    ['Surname','Last Name','สกุล(English)','สกุล'],
    fnameTh:  ['ชื่อ(ไทย)','ชื่อ(Thai)','ชื่อไทย'],
    lnameTh:  ['สกุล(ไทย)','สกุล(Thai)','สกุลไทย'],
    status:   ['สถานะ','Status','Active'],
    title:    ['คำนำหน้าชื่อ(ไทย)','Title','คำนำหน้า']
  });

  var out = [];
  for (var r = hdrIdx + 1; r < values.length; r++) {
    var row = values[r];
    var id   = String(_get(row, col.id, '')).replace(/\.0$/,'').trim();
    var pos  = normalizePosition(_get(row, col.pos, ''));
    var team = normalizeTeam(_get(row, col.team, ''));
    var stat = String(_get(row, col.status, '')).trim();
    if (!id || !pos || !team) continue;
    if (stat && stat.toLowerCase() !== 'active') continue;
    out.push({
      i:       id,
      n:       String(_get(row, col.fname, '')).trim(),
      ln:      String(_get(row, col.lname, '')).trim(),
      nth:     String(_get(row, col.fnameTh, '')).trim(),
      lnth:    String(_get(row, col.lnameTh, '')).trim(),
      p:       pos,
      t:       team,
      title:   String(_get(row, col.title, '')).trim(),
      active:  true
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// READ — Flights (one day)
// ───────────────────────────────────────────────────────────────────────
function pullFlights(date) {
  var ss = SpreadsheetApp.openById(CFG.FLIGHT_FILE_ID);
  var sh = CFG.FLIGHT_TAB ? ss.getSheetByName(CFG.FLIGHT_TAB) : ss.getSheets()[0];
  if (!sh) throw new Error('Flight tab not found');
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];

  var hdrIdx = _findHeaderRow(values, ['Airlines','FLT','Flight','Date']);
  var headers = values[hdrIdx].map(function(h){return String(h||'').trim();});
  var col = _colMap(headers, {
    date:    ['Date','Flight Date','flight_date','วันที่'],
    airline: ['Airlines','Airline','airline'],
    flt:     ['FLT.No','FLT No','Flight','Flight No','flight_no'],
    sta:     ['STA','Arrival','arr_time'],
    std:     ['STD','Departure','dep_time'],
    route:   ['Routing','Route','From-To'],
    type:    ['Type','A/C Type','aircraft','Aircraft'],
    pax:     ['PAX','Pax','Passengers'],
    bay:     ['Bay','Stand'],
    gate:    ['Gate']
  });

  var targetISO = _toISO(date);
  var out = [];
  for (var r = hdrIdx + 1; r < values.length; r++) {
    var row = values[r];
    var rowDate = _toISO(_get(row, col.date, ''));
    if (targetISO && rowDate && rowDate !== targetISO) continue;
    var airline = String(_get(row, col.airline, '')).trim().toUpperCase();
    var flt     = String(_get(row, col.flt, '')).trim().toUpperCase();
    if (!flt) continue;
    var team = AIRLINE_TO_TEAM[airline] || normalizeTeam(airline);
    if (!team) continue;
    out.push({
      id:           team+'-'+rowDate+'-'+flt,     // STABLE composite key (no row-index!)
      flight_no:    flt,
      flight_date:  rowDate,
      airline:      airline,
      team:         team,
      arr_time:     _toHHMM(_get(row, col.sta, '')),
      dep_time:     _toHHMM(_get(row, col.std, '')),
      routing:      String(_get(row, col.route, '')).trim(),
      aircraft:     String(_get(row, col.type, '')).trim(),
      pax:          parseInt(_get(row, col.pax, 0), 10) || 0,
      bay:          String(_get(row, col.bay, '')).trim(),
      gate:         String(_get(row, col.gate, '')).trim()
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// READ — Assignments (one day, flat schema)
// ───────────────────────────────────────────────────────────────────────
function pullAssignments(date) {
  var iso  = _toISO(date);
  var sh   = _getOrCreateDateTab(iso);
  if (!sh) return {};
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return {};
  var hdr = values[0].map(function(h){return String(h||'').trim();});
  var col = _colMap(hdr, {
    date:'Date', team:'Team', flight:'Flight', fi:'FI',
    role:'Role', slot:'Slot', emp:'EmpID', name:'EmpName', at:'At', by:'By'
  });
  // Build into HTML's expected shape: { "team-YYYY-MM-DD-flightId": { role: [empId,...] } }
  var out = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (!row.some(function(c){return String(c).trim();})) continue;
    var d    = _toISO(_get(row, col.date,''));
    var t    = String(_get(row, col.team,'')).trim();
    var flt  = String(_get(row, col.flight,'')).trim();
    var role = String(_get(row, col.role,'')).trim();
    var slot = parseInt(_get(row, col.slot,0), 10) || 0;
    var emp  = String(_get(row, col.emp,'')).replace(/\.0$/,'').trim();
    if (!d || !t || !flt || !role || !emp) continue;
    var key = t+'-'+d+'-'+flt;
    if (!out[key]) out[key] = {};
    if (!out[key][role]) out[key][role] = [];
    while (out[key][role].length <= slot) out[key][role].push(null);
    out[key][role][slot] = emp;
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────
// WRITE — upsert one assignment slot
// ───────────────────────────────────────────────────────────────────────
function upsertAssignment(body, actor) {
  // body: {date, team, flight, role, slot, empId, empName}
  var iso = _toISO(body.date);
  var sh  = _getOrCreateDateTab(iso);
  var values = sh.getDataRange().getValues();
  var hdr = values[0].map(function(h){return String(h||'').trim();});
  var col = _colMap(hdr, {
    date:'Date', team:'Team', flight:'Flight', fi:'FI',
    role:'Role', slot:'Slot', emp:'EmpID', name:'EmpName', at:'At', by:'By'
  });

  // Find existing row with matching composite key
  var slotN = parseInt(body.slot,10) || 0;
  var foundRow = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(_get(values[r], col.team,'')).trim() === body.team
        && String(_get(values[r], col.flight,'')).trim() === body.flight
        && String(_get(values[r], col.role,'')).trim() === body.role
        && (parseInt(_get(values[r], col.slot,0),10)||0) === slotN) {
      foundRow = r; break;
    }
  }
  var newRow = _buildRow(hdr, {
    Date:    iso,
    Team:    body.team,
    Flight:  body.flight,
    FI:      body.fi || '',
    Role:    body.role,
    Slot:    slotN,
    EmpID:   body.empId,
    EmpName: body.empName || '',
    At:      new Date().toISOString(),
    By:      actor
  });
  if (foundRow > 0) {
    sh.getRange(foundRow+1, 1, 1, hdr.length).setValues([newRow]);
    return {updated: 1, row: foundRow+1};
  }
  sh.appendRow(newRow);
  return {inserted: 1};
}

// ───────────────────────────────────────────────────────────────────────
// WRITE — delete one assignment slot
// ───────────────────────────────────────────────────────────────────────
function deleteAssignment(body, actor) {
  var iso = _toISO(body.date);
  var sh  = _getOrCreateDateTab(iso);
  var values = sh.getDataRange().getValues();
  var hdr = values[0].map(function(h){return String(h||'').trim();});
  var col = _colMap(hdr, {team:'Team', flight:'Flight', role:'Role', slot:'Slot'});
  var slotN = parseInt(body.slot,10) || 0;
  for (var r = values.length-1; r >= 1; r--) {
    if (String(_get(values[r], col.team,'')).trim() === body.team
        && String(_get(values[r], col.flight,'')).trim() === body.flight
        && String(_get(values[r], col.role,'')).trim() === body.role
        && (parseInt(_get(values[r], col.slot,0),10)||0) === slotN) {
      sh.deleteRow(r+1);
      return {deleted: 1, row: r+1};
    }
  }
  return {deleted: 0};
}

// ───────────────────────────────────────────────────────────────────────
// WRITE — clear all assignments for a day (optionally one team)
// ───────────────────────────────────────────────────────────────────────
function clearDay(body, actor) {
  // body: {date, team?}  — team optional (clear whole day if omitted)
  var iso = _toISO(body.date);
  var sh  = _getOrCreateDateTab(iso);
  var lastRow = sh.getLastRow();
  if (lastRow <= 1) return {cleared: 0};
  if (!body.team) {
    sh.getRange(2,1,lastRow-1,sh.getLastColumn()).clearContent();
    return {cleared: lastRow-1};
  }
  var values = sh.getDataRange().getValues();
  var hdr = values[0].map(function(h){return String(h||'').trim();});
  var teamCol = hdr.indexOf('Team');
  var count = 0;
  for (var r = values.length-1; r >= 1; r--) {
    if (String(values[r][teamCol]||'').trim() === body.team) {
      sh.deleteRow(r+1); count++;
    }
  }
  return {cleared: count};
}

// ───────────────────────────────────────────────────────────────────────
// WRITE — server-side auto-assigner (atomic via LockService)
//
// Ported from HTML's solveDay() — open assignment mode:
//   • Eligible pool: active staff with position SUP/SNR/PSA
//   • Try home team first (sorted PSA→SNR→SUP to balance OT), then cross-team
//   • Each flight has SLA-derived time window [brief, post]
//   • Staff cannot overlap two flights' windows
//   • Existing assignments (manual ones) are preserved
//   • Returns {assigned, violations, batchInserted}
// ───────────────────────────────────────────────────────────────────────
function autoAssignDay(body, actor) {
  var iso = _toISO(body.date);
  if (!iso) throw new Error('autoAssignDay: invalid date '+body.date);
  var team = body.team || null;   // null = all teams

  // 1. Load fresh state from Sheets (inside lock — atomic snapshot)
  var allFlights = pullFlights(iso);
  var flights    = team ? allFlights.filter(function(f){return f.team===team;}) : allFlights;
  if (!flights.length) return {assigned:0, violations:[], note:'no flights for '+iso+(team?' team='+team:'')};

  var allStaff = pullStaff();
  var pool = allStaff.filter(function(s){return s.active && ['SUP','SNR','PSA'].indexOf(s.p) >= 0;});

  var existingAsn = pullAssignments(iso);  // {key: {role: [empId,...]}}
  var roster      = pullRoster();          // {TEAM-YYYY-MM-DD-EMPID: shiftCode}
  var loadCount   = {};                    // empId → #slots today (rotate work)

  // 2. Sort flights by briefing time (earliest first)
  flights.forEach(function(f){ f._tl = computeTL(f); });
  flights.sort(function(a,b){ return (a._tl ? a._tl.brief : 0) - (b._tl ? b._tl.brief : 0); });

  // 3. Build busy windows from EXISTING assignments (so we don't double-book)
  var busy = {};   // {empId: [{start, end, flightKey}]}
  function isBusy(id, s, e){ var w=busy[id]||[]; return w.some(function(x){return s<x.end && e>x.start;}); }
  function lockBusy(id, s, e, fk){ if(!busy[id])busy[id]=[]; busy[id].push({start:s,end:e,flightKey:fk}); }
  Object.keys(existingAsn).forEach(function(fk){
    var parts = fk.split('-');
    // key format: team-YYYY-MM-DD-FLIGHTNO → team is parts[0], rest is date+flight
    var flightInState = allFlights.find(function(f){return f.id===fk;});
    if (!flightInState) return;
    var tl = computeTL(flightInState); if (!tl) return;
    var fa = existingAsn[fk];
    Object.keys(fa).forEach(function(r){
      (fa[r]||[]).forEach(function(sid){
        if (sid) lockBusy(sid, tl.brief, tl.post, fk);
      });
    });
  });

  // 4. For each flight, fill missing slots greedy by role-area priority
  var newAssignments = [];   // each: {date, team, flight, role, slot, empId, empName}
  var violations = [];

  flights.forEach(function(f){
    var sla = getSLA(f.airline);
    var tl  = f._tl;
    if (!tl) return;
    var existing = existingAsn[f.id] || {};
    var usedThisFlight = {};
    Object.keys(existing).forEach(function(r){
      (existing[r]||[]).forEach(function(sid){if(sid)usedThisFlight[sid]=true;});
    });

    // Adaptive CT/G ↔ GATE: gate is real work. Fill it from fresh own-team
    // staff first; only when the team has no one left does a person already
    // on a CT/G slot this flight also work the gate (CT/G dual); cross-team
    // is the last resort. So a full team → separate CT and G people; a thin
    // team → some people do CT/G; very thin → borrow another team.
    var hasCTG = _hasCTG(sla);
    var gateDoubled = {};
    function ctgHolderIds(){
      var ids = [];
      Object.keys(existing).forEach(function(rc){
        if (arBaseCode(rc)==='CT/G') (existing[rc]||[]).forEach(function(s){if(s)ids.push(s);});
      });
      newAssignments.forEach(function(a){
        if (a.fi===f.id && arBaseCode(a.role)==='CT/G') ids.push(a.empId);
      });
      return ids;
    }
    function pickGateDouble(){
      var ids = ctgHolderIds();
      for (var k=0;k<ids.length;k++){
        if (gateDoubled[ids[k]]) continue;
        var st = pool.filter(function(s){return s.i===ids[k] && s.t===f.team;})[0];
        if (st) return st;
      }
      return null;
    }

    // ── Role priority: staged group (SUP → SNR control → open pool),
    //    then area ALL → CI → ARR → GATE within a group.
    var areaPriority = {ALL:0, CI:1, ARR:2, GATE:3};
    var sortedRoles = sla.roles.slice().sort(function(a,b){
      var ga = roleGroupRank(a[2]), gb = roleGroupRank(b[2]);
      if (ga !== gb) return ga - gb;
      return (areaPriority[a[3]]||9) - (areaPriority[b[3]]||9);
    });

    sortedRoles.forEach(function(r){
      var label = r[0], count = r[1], jobCode = r[2];
      var have  = (existing[jobCode]||[]).filter(function(x){return x;}).length;
      var need  = count - have;
      for (var slot = have; slot < count; slot++) {
        var cand = null, dual = false;
        var isSup = roleGroupRank(jobCode) === 0;
        if (hasCTG && _isGateCode(jobCode)) {
          // CT/G is the normal model: a check-in person continues to the
          // gate, so fill gate from a CT/G holder first, then fresh own
          // team, then cross-team.
          var dbl = pickGateDouble();
          if (dbl) { cand = dbl; dual = true; }
          if (!cand) cand = pickCandidate(pool, f.team, jobCode, tl.brief, tl.post, usedThisFlight, busy, roster, iso, 'home', false, loadCount);
          if (!cand) cand = pickCandidate(pool, f.team, jobCode, tl.brief, tl.post, usedThisFlight, busy, roster, iso, 'cross', false, loadCount);
        } else {
          cand = pickCandidate(pool, f.team, jobCode, tl.brief, tl.post, usedThisFlight, busy, roster, iso, undefined, isSup, loadCount);
        }
        if (!cand) {
          violations.push({date:iso, flight:f.flight_no, team:f.team, role:jobCode, slot:slot, reason:'no candidate available'});
          break;
        }
        newAssignments.push({
          date:iso, team:f.team, flight:f.flight_no, role:jobCode, slot:slot,
          empId:cand.i, empName:cand.n+' '+cand.ln, fi:f.id
        });
        loadCount[cand.i] = (loadCount[cand.i]||0) + 1;   // rotate work fairly
        if (dual) {
          gateDoubled[cand.i] = true;   // already used+busy as CT/G — doubling is intentional, don't re-lock
        } else if (isSup) {
          usedThisFlight[cand.i] = true; // supervises across flights — no time-lock
        } else {
          usedThisFlight[cand.i] = true;
          lockBusy(cand.i, tl.brief, tl.post, f.id);
        }
      }
    });
  });

  // 5. Batch-write new assignments to Sheet
  if (newAssignments.length) {
    var sh = _getOrCreateDateTab(iso);
    var hdr = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0]
                .map(function(h){return String(h||'').trim();});
    var rows = newAssignments.map(function(a){
      return _buildRow(hdr, {
        Date: iso, Team: a.team, Flight: a.flight, FI: a.fi || '',
        Role: a.role, Slot: a.slot, EmpID: a.empId, EmpName: a.empName,
        At: new Date().toISOString(), By: actor
      });
    });
    sh.getRange(sh.getLastRow()+1, 1, rows.length, hdr.length).setValues(rows);
  }

  return {
    assigned: newAssignments.length,
    violations: violations,
    flightsProcessed: flights.length,
    poolSize: pool.length
  };
}

// ── Position → Role eligibility + priority (mirrors AR_RULES in Index.html)
// Positions normalized to SUP / SNR / PSA. Array order = pick priority.
// CT/G covers GATE: roles are filled CI→GATE (areaPriority in autoAssignDay)
// and usedThisFlight blocks re-using one person, so a CT/G person is never
// also counted as a separate gate agent for the same flight.
var AR_RULES = {
  'SUP' : ['SUP'],
  'CT/G': ['SUP','SNR','PSA'],
  'GA'  : ['PSA','SNR','SUP'],
  'GATE': ['PSA','SNR','SUP'],
  'GM'  : ['SNR','PSA','SUP'],
  'ARR' : ['PSA','SNR'],
  'STBY': ['PSA','SNR','SUP'],
  'FC'  : ['SUP','SNR'],
  'CF'  : ['SUP','SNR'],
  'SOD' : ['SUP','SNR'],
  'DEFAULT': ['SUP','SNR','PSA']
};
function arBaseCode(code){ return String(code||'').replace(/\d+$/,'').toUpperCase(); }
function arRoleOrder(code){ return AR_RULES[arBaseCode(code)] || AR_RULES.DEFAULT; }

// Canonical role normaliser (mirrors Index.html normRole) — collapses any
// team's raw role code to one canonical code+category for uniform
// reporting across the 5 team patterns. Does not affect assignment.
// Official AOTGA v2 normaliser (mirrors Index.html). Maps any legacy/
// team raw code → one official v2 code + category. Reporting only —
// does NOT affect assignment.
var ROLE_V2CAT = {'F1/PRIO':'Counter — Premium','F2/PRIO':'Counter — Premium',
  'W1/PRIO':'Counter — Premium','W2/PRIO':'Counter — Premium','J1/PRIO':'Counter — Premium',
  'J2/PRIO':'Counter — Premium','WEB1':'Counter — Digital','WEB2':'Counter — Digital',
  'Y1':'Counter — Economy','Y2':'Counter — Economy','Y3':'Counter — Economy','Y4':'Counter — Economy',
  'Y5':'Counter — Economy','Y6':'Counter — Economy','Y7':'Counter — Economy','GC':'Gate',
  'GC(INT)':'Gate','GA':'Gate','G-D':'Gate','G-I':'Gate','GBD':'Gate','G(B)':'Gate',
  'ARR':'Arrival','AC':'Arrival','BGO':'Arrival','FR':'Flow Control','FC':'Flow Control',
  'SOD':'Flow Control','TF/CIQ':'Escort','ESCT':'Escort','WEL':'Service','SD':'Service',
  'FLW':'Service','BIR':'Service','POST1':'Service','CRW':'Crew Handling','DOC/CREWSIGN':'Crew Handling',
  'DOC':'Admin','PFD':'Admin','APPS':'Admin','OJT':'Training','ASST':'Training','OTHER':'Other'};
var ROLE_MIGRATE = {SPVR:'SOD',SUP:'SOD',SOD:'SOD',ASM:'SOD',SM:'SOD',PSM:'SOD',FC:'FC',
  CF:'FC',FR:'FR',GC:'GC','GM(INT)':'GC(INT)','GC(INT)':'GC(INT)',GM:'GC',GK:'GA',G:'GA',
  GA:'GA',GATE:'GA',GB:'GA',BDRP:'GA','G-D':'G-D','G-I':'G-I',GBD:'GBD',C1:'Y1',C2:'Y2',
  C3:'Y3',C4:'Y4',C5:'Y5',C6:'Y6',C7:'Y7',CT1:'J1/PRIO',CT2:'W1/PRIO',CT3:'Y3',CT4:'Y4',
  CT5:'Y5','CT-BG':'WEB1','CT-ECO':'Y1',CTR:'Y1',KSK:'WEB1',KIOSK:'WEB1',CS:'GA',RF:'SD',
  ARR:'ARR',AC:'AC',BGO:'BGO',BINGO:'BGO',INAD:'TF/CIQ',CIQ:'TF/CIQ',TF:'TF/CIQ',ESCT:'ESCT',
  WEL:'WEL',SD:'SD',FLW:'FLW',BIR:'BIR',POST1:'POST1',CRW:'CRW',CREW:'CRW',CREWSIGN:'CRW',
  PFD:'PFD',DOC:'DOC',FILE:'PFD',SUM:'PFD',APPS:'APPS',PSC:'DOC',BUS:'GBD',DEBRIEF:'PFD',
  OJT:'OJT',ASST:'ASST',TRN:'OJT',STBY:'POST1'};
function normRole(raw){
  var s = String(raw||'').trim().toUpperCase();
  if (!s) return {code:'-',cat:'Other'};
  if (ROLE_V2CAT[s]) return {code:s, cat:ROLE_V2CAT[s]};
  s = s.replace(/^(KC|OZ|KE|9C|CA|CZ|FM|3U|HX|MH|QR|EK|TR|JQ|TK|AK|QZ|8M|SV|WK|WY|SQ|EY|SU|PG|CX|HB|ZF|G9|6E|QP|IT|IX|AI|DE|OM|FY|UO)\b[\/\-]/,'');
  if (ROLE_V2CAT[s]) return {code:s, cat:ROLE_V2CAT[s]};
  var prim = s.split(/[\/+]/)[0].trim().replace(/\(.*\)/,'').replace(/\s+\d+$/,'');
  var base = prim.replace(/\d+$/,'');
  var mc = ROLE_MIGRATE[s] || ROLE_MIGRATE[prim] || ROLE_MIGRATE[base];
  if (!mc){
    if (/^[FWJ]\d/.test(prim)) mc = prim.charAt(0)+'1/PRIO';
    else if (/^WEB/.test(prim)) mc = 'WEB1';
    else if (/^[YHC]\d/.test(prim)) mc = 'Y1';
    else if (/^G\d|^G$/.test(prim)) mc = 'GA';
  }
  if (mc && ROLE_V2CAT[mc]) return {code:mc, cat:ROLE_V2CAT[mc]};
  return {code:(mc||s), cat:'Other'};
}

// Staged fill order (mirrors Index.html ROLE_GROUP): the human planner
// fills the duty supervisor first, then SNR control (FC/CF/GC/GM), then
// the open counter/arrival/gate-agent pool. Lower rank = filled earlier.
var ROLE_GROUP = {
  'SUP':'SUP_ONLY', 'SOD':'SUP_ONLY',
  'FC':'SNR_PLUS', 'CF':'SNR_PLUS', 'GC':'SNR_PLUS', 'GM':'SNR_PLUS'
};
function roleGroupRank(jobCode){
  var g = ROLE_GROUP[arBaseCode(jobCode)];
  return g === 'SUP_ONLY' ? 0 : g === 'SNR_PLUS' ? 1 : 2;
}

// Pick best candidate for a role at a team — try home, then cross-team
// scope: 'home' = own team only · 'cross' = other teams only ·
// undefined/'any' = home then cross (legacy behaviour, control roles).
// ignoreBusy: supervisory roles (SUP) oversee the shift, not one flight,
// so one SUP may cover several flights even with overlapping windows.
function pickCandidate(pool, team, jobCode, brief, post, usedThisFlight, busy, roster, iso, scope, ignoreBusy, loadCount) {
  // Position priority is role-specific (SUP-only / agent-first / SNR-first)
  var posOrder = arRoleOrder(jobCode);
  function isBusy(id){ if (ignoreBusy) return false; var w=busy[id]||[]; return w.some(function(x){return brief<x.end && post>x.start;}); }
  // On-shift gate: staffer must have a WORK shift that covers the flight
  // window (mirrors client shiftOK). Without this the server booked
  // OFF/leave staff. roster/iso may be absent in older callers → skip.
  function onShift(s){
    if (!roster || !iso) return true;
    return _shiftCovers(_shiftWindow(roster, s.t, iso, s.i), brief, post);
  }
  // Rotate: prefer whoever holds the fewest slots so far today.
  function byLoad(a,b){ return ((loadCount&&loadCount[a.i])||0) - ((loadCount&&loadCount[b.i])||0); }
  function candidatesAt(t, p) {
    return pool.filter(function(s){
      return s.t===t && s.p===p && !usedThisFlight[s.i] && !isBusy(s.i) && onShift(s);
    }).sort(byLoad);
  }
  if (scope !== 'cross') {
    for (var i = 0; i < posOrder.length; i++) {
      var c = candidatesAt(team, posOrder[i]);
      if (c.length) return c[0];
    }
  }
  if (scope !== 'home') {
    for (var j = 0; j < posOrder.length; j++) {
      var p = posOrder[j];
      var x = pool.filter(function(s){
        return s.t !== team && s.p === p && !usedThisFlight[s.i] && !isBusy(s.i) && onShift(s);
      }).sort(byLoad);
      if (x.length) return Object.assign({}, x[0], {fromOther:true});
    }
  }
  return null;
}

// Compute time window for a flight: [brief, post] in minutes from midnight
function computeTL(flight) {
  var sla = getSLAraw(flight.airline);
  var std = _parseHHMM(flight.dep_time);
  if (std == null) return null;
  return {
    brief: std + sla.ci - sla.brief,
    open:  std + sla.ci,
    close: std + sla.cc,
    gate:  std + sla.go,
    std:   std,
    post:  std + sla.post
  };
}

function _parseHHMM(s) {
  if (!s) return null;
  var m = String(s).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1],10)*60 + parseInt(m[2],10);
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────
function _me() {
  try { return Session.getActiveUser().getEmail() || ''; }
  catch(e){ return ''; }
}
// This is a STANDALONE web app (serves Index.html via HtmlService, not
// bound to a spreadsheet). getDocumentLock() is only valid for
// container-bound scripts — standalone returns null, so lock.tryLock()
// threw on every write and ALL saves failed permanently. Use the script
// lock (valid for standalone); fall back defensively.
function _acquireLock() {
  try { var l = LockService.getScriptLock(); if (l) return l; } catch(e){}
  try { return LockService.getDocumentLock(); } catch(e2){ return null; }
}

function isAuthorized(email) {
  if (!email) return false;
  if (CFG.ALLOWED_WRITERS && CFG.ALLOWED_WRITERS.length) {
    return CFG.ALLOWED_WRITERS.indexOf(email) >= 0;
  }
  if (!CFG.MASTER_FILE_ID) return true;  // no gate — allow domain user
  try {
    var ss = SpreadsheetApp.openById(CFG.MASTER_FILE_ID);
    var sh = ss.getSheetByName(CFG.USERS_TAB);
    if (!sh) return true;
    var values = sh.getDataRange().getValues();
    var emailCol = values[0].indexOf('Email');
    if (emailCol < 0) return true;
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][emailCol]||'').trim().toLowerCase() === email.toLowerCase()) return true;
    }
    return false;
  } catch(e){ return true; }
}

// Step-by-step explanation of WHY canWrite is true/false.
// Read-only & safe to expose — helps diagnose deployment / Users-tab issues.
function _authDiag() {
  var active = '', effective = '';
  try { active    = Session.getActiveUser().getEmail() || ''; } catch(e){}
  try { effective = Session.getEffectiveUser().getEmail() || ''; } catch(e){}

  var d = {
    activeUser:    active,
    effectiveUser: effective,
    allowedWritersGate: !!(CFG.ALLOWED_WRITERS && CFG.ALLOWED_WRITERS.length),
    masterFileSet: !!CFG.MASTER_FILE_ID,
    usersTabFound: false,
    emailColFound: false,
    inUsersTab:    false,
    canWrite:      false,
    reason:        ''
  };

  if (!active) {
    d.reason = 'activeUser is empty — web app is NOT running as "Execute as: User accessing the web app", '
             + 'or access is not restricted to the domain. Google returns no email for anonymous access. '
             + 'Re-deploy: Execute as = User accessing the web app, Who has access = Anyone within aotga.com.';
    d.canWrite = false;
    return d;
  }
  if (d.allowedWritersGate) {
    d.canWrite = CFG.ALLOWED_WRITERS.indexOf(active) >= 0;
    d.reason   = d.canWrite ? 'in ALLOWED_WRITERS' : active + ' not in ALLOWED_WRITERS list';
    return d;
  }
  if (!CFG.MASTER_FILE_ID) {
    d.canWrite = true;
    d.reason   = 'no MASTER_FILE_ID gate — domain user allowed';
    return d;
  }
  try {
    var ss = SpreadsheetApp.openById(CFG.MASTER_FILE_ID);
    var sh = ss.getSheetByName(CFG.USERS_TAB);
    if (!sh) {
      d.canWrite = true;
      d.reason   = 'Users tab "' + CFG.USERS_TAB + '" not found — gate open, domain user allowed';
      return d;
    }
    d.usersTabFound = true;
    var values   = sh.getDataRange().getValues();
    var emailCol = values[0].indexOf('Email');
    if (emailCol < 0) {
      d.canWrite = true;
      d.reason   = 'No "Email" column header in Users tab — gate open, domain user allowed';
      return d;
    }
    d.emailColFound = true;
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][emailCol]||'').trim().toLowerCase() === active.toLowerCase()) {
        d.inUsersTab = true; break;
      }
    }
    d.canWrite = d.inUsersTab;
    d.reason   = d.inUsersTab
      ? active + ' found in Users tab'
      : active + ' NOT in Users tab "' + CFG.USERS_TAB + '" (Email column) — add this email there to grant write access';
    return d;
  } catch(err) {
    d.canWrite = true;
    d.reason   = 'Users-tab check threw (' + (err.message||err) + ') — fail-open, domain user allowed';
    return d;
  }
}

function _log(user, action, detail) {
  try {
    var ss = SpreadsheetApp.openById(CFG.MASTER_FILE_ID || CFG.ASSIGNMENT_FILE_ID);
    var sh = ss.getSheetByName(CFG.LOGS_TAB) ||
             ss.insertSheet(CFG.LOGS_TAB).appendRow(['Timestamp','User','Action','Detail']) &&
             ss.getSheetByName(CFG.LOGS_TAB);
    sh.appendRow([new Date(), user, action, detail]);
  } catch(e){}
}

function _getOrCreateDateTab(iso) {
  var ss = SpreadsheetApp.openById(CFG.ASSIGNMENT_FILE_ID);
  var tabName = _fmtTab(iso);
  var sh = ss.getSheetByName(tabName);
  if (!sh) {
    sh = ss.insertSheet(tabName);
    sh.appendRow(CFG.ASSIGNMENT_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function _fmtTab(iso) {
  // ddMMM format → "13MAY"  (matches BotConfig DATE_TAB_FORMAT)
  var d = new Date(iso);
  if (isNaN(d)) return iso;
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'ddMMM').toUpperCase();
}

function _toISO(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v)) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  // try dd/MM/yyyy or dd-MM-yyyy
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    var y = m[3].length === 2 ? '20'+m[3] : m[3];
    return y+'-'+_p(m[2])+'-'+_p(m[1]);
  }
  // "17MAY26", "17 MAY 26", "17-MAY-2026", "1MAY" — the format this dept
  // uses everywhere; new Date() can't parse it so flights came back with
  // a blank date and never matched the selected day (Daily Ops empty).
  var mm = s.toUpperCase().match(/^(\d{1,2})\s*[-\/ ]?\s*(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\s*[-\/ ]?\s*(\d{2,4})?/);
  if (mm) {
    var MO={JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12}[mm[2]];
    var yy = mm[3] ? (mm[3].length===2 ? '20'+mm[3] : mm[3]) : String(new Date().getFullYear());
    return yy+'-'+_p(MO)+'-'+_p(mm[1]);
  }
  var dt = new Date(s);
  if (!isNaN(dt)) return Utilities.formatDate(dt, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return '';
}

function _toHHMM(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  var s = String(v).trim();
  var m = s.match(/(\d{1,2}):?(\d{2})/);
  if (m) return _p(m[1])+':'+_p(m[2]);
  return s;
}

function _todayISO() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function _p(n) { n = String(n); return n.length < 2 ? '0'+n : n; }

function _findHeaderRow(values, markers) {
  for (var i = 0; i < Math.min(5, values.length); i++) {
    if (values[i].some(function(c){
      var s = String(c||'');
      return markers.some(function(m){return s.indexOf(m) >= 0;});
    })) return i;
  }
  return 0;
}

function _colMap(headers, want) {
  var out = {};
  Object.keys(want).forEach(function(k){
    var candidates = [].concat(want[k]);
    for (var j = 0; j < candidates.length; j++) {
      var idx = headers.indexOf(candidates[j]);
      if (idx >= 0) { out[k] = idx; return; }
      // case-insensitive partial
      for (var h = 0; h < headers.length; h++) {
        if (String(headers[h]).toLowerCase().indexOf(String(candidates[j]).toLowerCase()) >= 0) {
          out[k] = h; return;
        }
      }
    }
    out[k] = -1;
  });
  return out;
}

function _get(row, idx, dflt) {
  if (idx < 0 || idx == null) return dflt;
  return row[idx] != null ? row[idx] : dflt;
}

function _buildRow(headers, valuesByHeader) {
  return headers.map(function(h){
    return valuesByHeader[h] != null ? valuesByHeader[h] : '';
  });
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ═══════════════════════════════════════════════════════════════════════
// TIME & ATTENDANCE — Outsource staff: check-in / check-out · OT · Leave
// ─────────────────────────────────────────────────────────────────────
// Three tabs live in the Roster DB spreadsheet (CFG.ROSTER_FILE_ID) so the
// crowded Pax Manpower file is left alone:
//
//   Outsource   registry of vendor staff (they are NOT in the staff master)
//   Attendance  one row per (Date, EmpID) — the punch record
//   Requests    one row per OT / Leave request + its approval decision
//
// Punch times are stamped BY THE SERVER (Session timezone), never by the
// browser clock. A staffer may punch only for themself; punching for
// someone else — and any manual time edit — requires a writer (Users tab).
// Approving a leave request also writes the leave code into the roster so
// Monthly Roster / Daily Ops immediately see the person as unavailable.
// ═══════════════════════════════════════════════════════════════════════
var ATT = {
  OUTSOURCE_TAB:  'Outsource',
  ATTENDANCE_TAB: 'Attendance',
  REQUEST_TAB:    'Requests',

  LATE_GRACE_MIN:      15,   // in-punch later than schedule+grace → LATE
  EARLY_OUT_GRACE_MIN: 15,   // out-punch earlier than schedule-grace → EARLY_OUT
  NO_OUT_AFTER_MIN:    120,  // still open this long after shift end → NO_OUT
  DEFAULT_SHIFT_HRS:   8,    // used when the day has no roster shift code
  OT_ROUND_MIN:        30,   // OT is floored to this many minutes
  MAX_OT_HRS:          12,   // sanity cap on a single OT request

  // Leave codes deliberately reuse SHIFT_DB.specials so an approved leave
  // is a roster code the rest of the app already understands.
  LEAVE_TYPES: {AL:'Annual Leave', SL:'Sick Leave', BL:'Personal Leave', Vac:'Vacation'}
};

var OUTSOURCE_HEADERS  = ['EmpID','Name','Surname','NameTh','Vendor','Team','Position',
                          'Phone','Email','StartDate','EndDate','Active','Note','UpdatedAt','UpdatedBy'];
var ATTENDANCE_HEADERS = ['Date','EmpID','Name','Vendor','Team','Source','Shift','SchedIn','SchedOut',
                          'InAt','InBy','OutAt','OutBy','WorkHrs','OtHrs','OtApproved','Flags','Status',
                          'Note','UpdatedAt','UpdatedBy'];
var REQUEST_HEADERS    = ['ReqID','Type','EmpID','Name','Vendor','Team','SubType','DateFrom','DateTo',
                          'Days','Hours','TimeFrom','TimeTo','Reason','Status','CreatedAt','CreatedBy',
                          'DecidedAt','DecidedBy','DecideNote','PrevCodes'];

// ── generic sheet helpers (row objects keyed by header) ────────────────
function _attTab(name, headers) {
  var ss = SpreadsheetApp.openById(_rosterFileId());
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function _attRows(sh) {
  var values = sh.getDataRange().getValues();
  var out = {header: [], rows: []};
  if (!values.length) return out;
  out.header = values[0].map(function(h){ return String(h||'').trim(); });
  for (var r = 1; r < values.length; r++) {
    var o = {_row: r + 1}, blank = true;
    for (var c = 0; c < out.header.length; c++) {
      var h = out.header[c];
      if (!h) continue;
      o[h] = values[r][c];
      if (values[r][c] !== '' && values[r][c] != null) blank = false;
    }
    if (!blank) out.rows.push(o);
  }
  return out;
}

function _attWrite(sh, header, rowIdx, obj) {
  sh.getRange(rowIdx, 1, 1, header.length)
    .setValues([header.map(function(h){ return obj[h] != null ? obj[h] : ''; })]);
}

function _attAppend(sh, header, obj) {
  sh.appendRow(header.map(function(h){ return obj[h] != null ? obj[h] : ''; }));
  return sh.getLastRow();
}

// ── timestamps: stored as "yyyy-MM-dd HH:mm" in script timezone ────────
function _nowStamp() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

function _toStamp(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4}-\d{1,2}-\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (m) {
    var d = m[1].split('-');
    return d[0]+'-'+_p(d[1])+'-'+_p(d[2])+' '+_p(m[2])+':'+m[3];
  }
  return s;
}

// Wall-clock minutes — Date.UTC on local components, so the diff between
// two stamps is exact and timezone/DST plays no part.
function _stampMin(stamp) {
  var m = String(stamp || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
}

function _stampOf(iso, hhmm) { return iso + ' ' + _toHHMM(hhmm); }
function _stampTime(stamp) { var m = String(stamp||'').match(/ (\d{2}:\d{2})$/); return m ? m[1] : ''; }
function _stampDate(stamp) { var m = String(stamp||'').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : ''; }

// Date list from..to inclusive (capped so a typo can't write 10k rows)
function _dateRange(fromISO, toISO) {
  var out = [], d = new Date(fromISO + 'T00:00:00'), end = new Date(toISO + 'T00:00:00');
  if (isNaN(d) || isNaN(end) || end < d) return out;
  while (d <= end && out.length < 366) {
    out.push(Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

// ── people: Outsource registry + staff master ─────────────────────────
function pullOutsource() {
  var sh = _attTab(ATT.OUTSOURCE_TAB, OUTSOURCE_HEADERS);
  var data = _attRows(sh);
  var out = [];
  data.rows.forEach(function(r){
    var id = String(r.EmpID || '').replace(/\.0$/,'').trim();
    if (!id) return;
    var active = String(r.Active == null ? '' : r.Active).trim().toLowerCase();
    out.push({
      i:       id,
      n:       String(r.Name || '').trim(),
      ln:      String(r.Surname || '').trim(),
      nth:     String(r.NameTh || '').trim(),
      vendor:  String(r.Vendor || '').trim(),
      t:       String(r.Team || '').trim().toUpperCase(),
      p:       String(r.Position || 'PSA').trim().toUpperCase(),
      phone:   String(r.Phone || '').trim(),
      email:   String(r.Email || '').trim().toLowerCase(),
      start:   _toISO(r.StartDate),
      end:     _toISO(r.EndDate),
      active:  !(active === 'no' || active === 'false' || active === '0' || active === 'inactive'),
      note:    String(r.Note || '').trim(),
      src:     'OUT'
    });
  });
  return out;
}

// One person by id — Outsource registry first, then the staff master, so
// the same punch/request pipeline serves both populations.
function _attPerson(empId) {
  var id = String(empId || '').trim();
  if (!id) return null;
  var out = pullOutsource();
  for (var i = 0; i < out.length; i++) if (out[i].i === id) return out[i];
  var staff = pullStaff();
  for (var j = 0; j < staff.length; j++) {
    if (staff[j].i === id) {
      return Object.assign({}, staff[j], {vendor:'', email:'', src:'PSA'});
    }
  }
  return null;
}

// Which employee record belongs to the signed-in Google account?
// Outsource.Email first, then an optional EmpID column in the Users tab.
function _attEmpIdForEmail(email) {
  var e = String(email || '').trim().toLowerCase();
  if (!e) return '';
  var out = pullOutsource();
  for (var i = 0; i < out.length; i++) if (out[i].email && out[i].email === e) return out[i].i;
  try {
    var ss = SpreadsheetApp.openById(CFG.MASTER_FILE_ID);
    var sh = ss.getSheetByName(CFG.USERS_TAB);
    if (!sh) return '';
    var values = sh.getDataRange().getValues();
    if (!values.length) return '';
    var headers = values[0].map(function(h){ return String(h||'').trim(); });
    var col = _colMap(headers, {email:['Email'], id:['EmpID','รหัสพนักงาน','Employee ID']});
    if (col.email < 0 || col.id < 0) return '';
    for (var r = 1; r < values.length; r++) {
      if (String(values[r][col.email]||'').trim().toLowerCase() === e) {
        return String(values[r][col.id]||'').replace(/\.0$/,'').trim();
      }
    }
  } catch (err) { /* Users tab optional */ }
  return '';
}

// Self-service punch is open to any signed-in domain user for their OWN
// record; punching for anybody else is a supervisor action.
function _attAssertPunchAllowed(empId, actor) {
  if (!actor) throw new Error('ไม่พบบัญชีผู้ใช้ — เปิดผ่าน Web App URL แล้ว sign-in ก่อน');
  if (isAuthorized(actor)) return 'writer';
  if (_attEmpIdForEmail(actor) === String(empId || '').trim()) return 'self';
  throw new Error('unauthorized: ' + actor + ' ลงเวลาให้พนักงานคนอื่นไม่ได้ (ต้องอยู่ใน Users tab)');
}

function _attAssertWriter(actor) {
  if (!isAuthorized(actor)) {
    throw new Error('unauthorized: ' + actor + ' (not in Users tab or ALLOWED_WRITERS)');
  }
}

// ── derived attendance fields ─────────────────────────────────────────
// Everything the sheet stores that is *computed* goes through here, so a
// punch, a supervisor edit and an OT approval all recompute identically.
function _attRecalc(rec, roster, approvedOtHrs) {
  var code = roster[rec.Team + '-' + rec.Date + '-' + rec.EmpID] || '';
  var info = _lookupShift(code);
  var schedHrs = ATT.DEFAULT_SHIFT_HRS;
  rec.Shift = code;
  rec.SchedIn = ''; rec.SchedOut = '';
  if (info && info.kind === 'WORK') {
    rec.SchedIn  = info.in;
    rec.SchedOut = info.out;
    if (info.hrs) schedHrs = info.hrs;
  }

  var inMin  = _stampMin(rec.InAt);
  var outMin = _stampMin(rec.OutAt);
  var flags  = [];

  if (!code)                                    flags.push('NO_SHIFT');
  else if (info && info.kind === 'OFF')         flags.push('WORK_ON_OFF');
  else if (info && info.kind === 'LEAVE')       flags.push('WORK_ON_LEAVE');

  var work = 0;
  if (inMin != null && outMin != null) {
    var span = outMin - inMin;
    if (span < 0) span += 1440;                 // defensive: same-day rollover
    work = Math.round(span / 60 * 100) / 100;
  }
  rec.WorkHrs = work || '';

  // OT = worked beyond the rostered shift length, floored to OT_ROUND_MIN
  var ot = 0;
  if (work > schedHrs) {
    var otMin = Math.floor((work - schedHrs) * 60 / ATT.OT_ROUND_MIN) * ATT.OT_ROUND_MIN;
    ot = Math.round(otMin / 60 * 100) / 100;
  }
  rec.OtHrs = ot || '';
  rec.OtApproved = approvedOtHrs ? Math.round(approvedOtHrs * 100) / 100 : '';
  if (ot > (approvedOtHrs || 0) + 0.01) flags.push('OT_UNAPPROVED');

  if (rec.SchedIn && inMin != null) {
    var schedInMin = _stampMin(_stampOf(rec.Date, rec.SchedIn));
    if (schedInMin != null && inMin > schedInMin + ATT.LATE_GRACE_MIN) flags.push('LATE');
    if (schedInMin != null && inMin < schedInMin - 240) flags.push('EARLY_IN');
  }
  if (rec.SchedOut && outMin != null && info && info.kind === 'WORK') {
    var schedOutMin = _stampMin(_stampOf(rec.Date, rec.SchedOut));
    // overnight shift: scheduled out falls on the next calendar day
    if (schedOutMin != null && _parseHHMM(rec.SchedOut) <= _parseHHMM(rec.SchedIn)) schedOutMin += 1440;
    if (schedOutMin != null && outMin < schedOutMin - ATT.EARLY_OUT_GRACE_MIN) flags.push('EARLY_OUT');
  }

  if (inMin != null && outMin == null) {
    rec.Status = 'OPEN';
    var nowMin = _stampMin(_nowStamp());
    var endMin = rec.SchedOut ? _stampMin(_stampOf(rec.Date, rec.SchedOut)) : (inMin + schedHrs * 60);
    if (endMin != null && rec.SchedOut && _parseHHMM(rec.SchedOut) <= _parseHHMM(rec.SchedIn || '00:00')) endMin += 1440;
    if (nowMin != null && endMin != null && nowMin > endMin + ATT.NO_OUT_AFTER_MIN) flags.push('NO_OUT');
  } else if (inMin != null && outMin != null) {
    rec.Status = 'CLOSED';
  } else {
    rec.Status = rec.Status || 'OPEN';
  }

  rec.Flags = flags.join(',');
  return rec;
}

function _attToClient(r) {
  return {
    row:        r._row,
    date:       _toISO(r.Date),
    empId:      String(r.EmpID || '').replace(/\.0$/,'').trim(),
    name:       String(r.Name || ''),
    vendor:     String(r.Vendor || ''),
    team:       String(r.Team || ''),
    source:     String(r.Source || ''),
    shift:      String(r.Shift || ''),
    schedIn:    _toHHMM(r.SchedIn),
    schedOut:   _toHHMM(r.SchedOut),
    inAt:       _toStamp(r.InAt),
    inBy:       String(r.InBy || ''),
    outAt:      _toStamp(r.OutAt),
    outBy:      String(r.OutBy || ''),
    workHrs:    r.WorkHrs === '' || r.WorkHrs == null ? 0 : Number(r.WorkHrs),
    otHrs:      r.OtHrs === '' || r.OtHrs == null ? 0 : Number(r.OtHrs),
    otApproved: r.OtApproved === '' || r.OtApproved == null ? 0 : Number(r.OtApproved),
    flags:      String(r.Flags || '').split(',').filter(function(f){return f;}),
    status:     String(r.Status || ''),
    note:       String(r.Note || ''),
    updatedAt:  _toStamp(r.UpdatedAt),
    updatedBy:  String(r.UpdatedBy || '')
  };
}

// Approved OT hours per "empId|date" across the whole Requests tab.
function _approvedOtMap() {
  var data = _attRows(_attTab(ATT.REQUEST_TAB, REQUEST_HEADERS));
  var map = {};
  data.rows.forEach(function(r){
    if (String(r.Type||'').toUpperCase() !== 'OT') return;
    if (String(r.Status||'').toUpperCase() !== 'APPROVED') return;
    var id = String(r.EmpID||'').replace(/\.0$/,'').trim();
    var hrs = parseFloat(r.Hours) || 0;
    _dateRange(_toISO(r.DateFrom), _toISO(r.DateTo || r.DateFrom)).forEach(function(d){
      var k = id + '|' + d;
      map[k] = (map[k] || 0) + hrs;
    });
  });
  return map;
}

// ── READ ──────────────────────────────────────────────────────────────
function pullAttendance(from, to) {
  var f = _toISO(from) || _todayISO();
  var t = _toISO(to) || f;
  if (t < f) { var swap = f; f = t; t = swap; }
  var data = _attRows(_attTab(ATT.ATTENDANCE_TAB, ATTENDANCE_HEADERS));
  var out = [];
  data.rows.forEach(function(r){
    var d = _toISO(r.Date);
    if (d && d >= f && d <= t) out.push(_attToClient(r));
  });
  out.sort(function(a,b){
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return out;
}

function pullRequests(body) {
  body = body || {};
  var type   = String(body.type || '').toUpperCase();
  var status = String(body.status || '').toUpperCase();
  var empId  = String(body.empId || '').trim();
  var from   = _toISO(body.from), to = _toISO(body.to);
  var data   = _attRows(_attTab(ATT.REQUEST_TAB, REQUEST_HEADERS));
  var out = [];
  data.rows.forEach(function(r){
    var rec = {
      row:        r._row,
      reqId:      String(r.ReqID || ''),
      type:       String(r.Type || '').toUpperCase(),
      empId:      String(r.EmpID || '').replace(/\.0$/,'').trim(),
      name:       String(r.Name || ''),
      vendor:     String(r.Vendor || ''),
      team:       String(r.Team || ''),
      subType:    String(r.SubType || ''),
      dateFrom:   _toISO(r.DateFrom),
      dateTo:     _toISO(r.DateTo || r.DateFrom),
      days:       parseInt(r.Days, 10) || 0,
      hours:      parseFloat(r.Hours) || 0,
      timeFrom:   _toHHMM(r.TimeFrom),
      timeTo:     _toHHMM(r.TimeTo),
      reason:     String(r.Reason || ''),
      status:     String(r.Status || '').toUpperCase(),
      createdAt:  _toStamp(r.CreatedAt),
      createdBy:  String(r.CreatedBy || ''),
      decidedAt:  _toStamp(r.DecidedAt),
      decidedBy:  String(r.DecidedBy || ''),
      decideNote: String(r.DecideNote || '')
    };
    if (!rec.reqId) return;
    if (type && rec.type !== type) return;
    if (status && rec.status !== status) return;
    if (empId && rec.empId !== empId) return;
    if (from && rec.dateTo < from) return;
    if (to && rec.dateFrom > to) return;
    out.push(rec);
  });
  out.sort(function(a,b){ return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0; });
  return out;
}

// One call for the whole Check-In / OT-Leave section of the UI.
function attendanceBootstrap(date, from, to) {
  var d  = _toISO(date) || _todayISO();
  var f  = _toISO(from) || d;
  var t  = _toISO(to)   || d;
  var me = _me();
  return {
    me:         me,
    canWrite:   isAuthorized(me),
    myEmpId:    _attEmpIdForEmail(me),
    date:       d,
    from:       f,
    to:         t,
    now:        _nowStamp(),
    outsource:  pullOutsource(),
    attendance: pullAttendance(f, t),
    requests:   pullRequests({}),
    leaveTypes: ATT.LEAVE_TYPES,
    cfg:        {lateGrace: ATT.LATE_GRACE_MIN, otRound: ATT.OT_ROUND_MIN, defaultHrs: ATT.DEFAULT_SHIFT_HRS}
  };
}

// ── WRITE — punch in / out ────────────────────────────────────────────
// body: {empId, kind:'IN'|'OUT', date?, at?:'HH:mm', note?}
//   date/at are supervisor-only overrides; a staffer's own punch always
//   uses the server clock.
function punchAttendance(body) {
  body = body || {};
  var actor = _me();
  var empId = String(body.empId || '').trim();
  var kind  = String(body.kind || '').toUpperCase();
  if (!empId) throw new Error('punch: ต้องระบุรหัสพนักงาน');
  if (kind !== 'IN' && kind !== 'OUT') throw new Error('punch: kind ต้องเป็น IN หรือ OUT');

  var mode   = _attAssertPunchAllowed(empId, actor);
  var person = _attPerson(empId);
  if (!person) throw new Error('ไม่พบพนักงานรหัส ' + empId + ' (เพิ่มใน Outsource tab ก่อน)');
  if (person.active === false) throw new Error(empId + ' ถูกปิดสถานะ (inactive) — ลงเวลาไม่ได้');

  var now   = _nowStamp();
  var date  = _toISO(body.date) || _stampDate(now);
  var stamp = now;
  if (body.at) {
    if (mode !== 'writer') throw new Error('แก้เวลาเองได้เฉพาะผู้มีสิทธิ์ (Users tab)');
    stamp = _stampOf(date, body.at);
    if (!_stampMin(stamp)) throw new Error('รูปแบบเวลาไม่ถูกต้อง: ' + body.at);
  } else if (body.date && body.date !== _stampDate(now) && mode !== 'writer') {
    throw new Error('ลงเวลาย้อนหลังได้เฉพาะผู้มีสิทธิ์ (Users tab)');
  }

  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var sh   = _attTab(ATT.ATTENDANCE_TAB, ATTENDANCE_HEADERS);
    var data = _attRows(sh);
    var rec = null;
    for (var i = 0; i < data.rows.length; i++) {
      if (_toISO(data.rows[i].Date) === date &&
          String(data.rows[i].EmpID||'').replace(/\.0$/,'').trim() === empId) { rec = data.rows[i]; break; }
    }
    var isNew = !rec;
    if (isNew) {
      rec = {Date: date, EmpID: empId, Name: (person.n + ' ' + person.ln).trim(),
             Vendor: person.vendor || '', Team: person.t || '', Source: person.src || ''};
    }
    rec.Date = date; rec.EmpID = empId;
    rec.InAt  = _toStamp(rec.InAt);
    rec.OutAt = _toStamp(rec.OutAt);

    var already = false;
    if (kind === 'IN') {
      if (rec.InAt) already = true;
      else { rec.InAt = stamp; rec.InBy = actor; }
    } else {
      if (!rec.InAt) throw new Error(empId + ' ยังไม่ได้เช็คอินวันที่ ' + date);
      if (rec.OutAt) already = true;
      else {
        // out before in ⇒ overnight shift, the punch belongs to the next day
        if (_stampMin(stamp) != null && _stampMin(stamp) < _stampMin(rec.InAt)) {
          var d2 = new Date(new Date(date + 'T00:00:00').getTime() + 86400000);
          var nextDay = Utilities.formatDate(d2, Session.getScriptTimeZone(), 'yyyy-MM-dd');
          stamp = _stampOf(nextDay, _stampTime(stamp));
        }
        rec.OutAt = stamp; rec.OutBy = actor;
      }
    }
    if (body.note) rec.Note = String(body.note).slice(0, 300);
    rec.UpdatedAt = now; rec.UpdatedBy = actor;

    var otMap = _approvedOtMap();
    _attRecalc(rec, pullRoster(), otMap[empId + '|' + date] || 0);

    if (isNew) _attAppend(sh, data.header.length ? data.header : ATTENDANCE_HEADERS, rec);
    else _attWrite(sh, data.header, rec._row, rec);

    _log(actor, 'punch' + kind, empId + ' ' + date + ' ' + stamp + (already ? ' (already)' : ''));
    return {ok: true, already: already, mode: mode, record: _attToClient(rec)};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// Supervisor correction of one attendance row.
// body: {date, empId, inAt:'HH:mm'|'', outAt:'HH:mm'|'', note, remove:true?}
function saveAttendance(body) {
  body = body || {};
  var actor = _me();
  _attAssertWriter(actor);
  var date  = _toISO(body.date);
  var empId = String(body.empId || '').trim();
  if (!date || !empId) throw new Error('saveAttendance: ต้องมี date และ empId');

  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var sh   = _attTab(ATT.ATTENDANCE_TAB, ATTENDANCE_HEADERS);
    var data = _attRows(sh);
    var rec = null;
    for (var i = 0; i < data.rows.length; i++) {
      if (_toISO(data.rows[i].Date) === date &&
          String(data.rows[i].EmpID||'').replace(/\.0$/,'').trim() === empId) { rec = data.rows[i]; break; }
    }
    if (body.remove) {
      if (rec) sh.deleteRow(rec._row);
      _log(actor, 'deleteAttendance', empId + ' ' + date);
      return {ok: true, removed: true};
    }
    var person = _attPerson(empId);
    var isNew = !rec;
    if (isNew) {
      rec = {Date: date, EmpID: empId,
             Name: person ? (person.n + ' ' + person.ln).trim() : '',
             Vendor: person ? (person.vendor || '') : '',
             Team: person ? (person.t || '') : '',
             Source: person ? (person.src || '') : ''};
    }
    // '' clears the punch, undefined leaves it as-is
    if (body.inAt  != null) rec.InAt  = body.inAt  ? _stampOf(date, body.inAt) : '';
    if (body.outAt != null) {
      rec.OutAt = '';
      if (body.outAt) {
        var outStamp = _stampOf(date, body.outAt);
        var inMin = _stampMin(_toStamp(rec.InAt));
        if (inMin != null && _stampMin(outStamp) != null && _stampMin(outStamp) < inMin) {
          var d2 = new Date(date + 'T00:00:00');
          d2 = new Date(d2.getTime() + 86400000);
          outStamp = _stampOf(Utilities.formatDate(d2, Session.getScriptTimeZone(), 'yyyy-MM-dd'), body.outAt);
        }
        rec.OutAt = outStamp;
      }
    }
    if (body.note != null) rec.Note = String(body.note).slice(0, 300);
    if (rec.InAt && !rec.InBy) rec.InBy = actor;
    if (rec.OutAt && !rec.OutBy) rec.OutBy = actor;
    rec.UpdatedAt = _nowStamp(); rec.UpdatedBy = actor;

    var otMap = _approvedOtMap();
    _attRecalc(rec, pullRoster(), otMap[empId + '|' + date] || 0);

    if (isNew) _attAppend(sh, data.header.length ? data.header : ATTENDANCE_HEADERS, rec);
    else _attWrite(sh, data.header, rec._row, rec);

    _log(actor, 'saveAttendance', empId + ' ' + date + ' in=' + rec.InAt + ' out=' + rec.OutAt);
    return {ok: true, record: _attToClient(rec)};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ── WRITE — OT / Leave requests ───────────────────────────────────────
function _attNextReqId(rows, type, iso) {
  var prefix = (type === 'OT' ? 'OT-' : 'LV-') + iso.replace(/-/g, '') + '-';
  var max = 0;
  rows.forEach(function(r){
    var id = String(r.ReqID || '');
    if (id.indexOf(prefix) !== 0) return;
    var n = parseInt(id.slice(prefix.length), 10);
    if (n > max) max = n;
  });
  return prefix + _p(String(max + 1));
}

// body: {type:'OT'|'LEAVE', empId, dateFrom, dateTo?, hours?, subType?,
//        timeFrom?, timeTo?, reason}
function submitRequest(body) {
  body = body || {};
  var actor = _me();
  var empId = String(body.empId || '').trim();
  var type  = String(body.type || '').toUpperCase();
  if (!empId) throw new Error('ต้องระบุรหัสพนักงาน');
  if (type !== 'OT' && type !== 'LEAVE') throw new Error('type ต้องเป็น OT หรือ LEAVE');
  _attAssertPunchAllowed(empId, actor);          // self, or a writer acting for staff

  var person = _attPerson(empId);
  if (!person) throw new Error('ไม่พบพนักงานรหัส ' + empId);

  var from = _toISO(body.dateFrom);
  var to   = _toISO(body.dateTo) || from;
  if (!from) throw new Error('วันที่ไม่ถูกต้อง');
  if (to < from) { var s = from; from = to; to = s; }
  var days = _dateRange(from, to);
  if (!days.length) throw new Error('ช่วงวันที่ไม่ถูกต้อง');
  if (days.length > 62) throw new Error('ขอครั้งละไม่เกิน 62 วัน');

  var reason = String(body.reason || '').trim().slice(0, 500);
  if (!reason) throw new Error('กรุณาระบุเหตุผล');

  var hours = 0, subType = '';
  if (type === 'OT') {
    hours = parseFloat(body.hours) || 0;
    if (hours <= 0) throw new Error('ระบุจำนวนชั่วโมง OT');
    if (hours > ATT.MAX_OT_HRS) throw new Error('OT ต่อวันไม่เกิน ' + ATT.MAX_OT_HRS + ' ชม.');
  } else {
    subType = String(body.subType || '').trim();
    if (!ATT.LEAVE_TYPES[subType]) {
      throw new Error('ประเภทการลาไม่ถูกต้อง (' + Object.keys(ATT.LEAVE_TYPES).join('/') + ')');
    }
  }

  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var sh   = _attTab(ATT.REQUEST_TAB, REQUEST_HEADERS);
    var data = _attRows(sh);
    // block a second live request of the same type over the same dates
    for (var i = 0; i < data.rows.length; i++) {
      var r = data.rows[i];
      if (String(r.EmpID||'').replace(/\.0$/,'').trim() !== empId) continue;
      if (String(r.Type||'').toUpperCase() !== type) continue;
      var st = String(r.Status||'').toUpperCase();
      if (st !== 'PENDING' && st !== 'APPROVED') continue;
      var rf = _toISO(r.DateFrom), rt = _toISO(r.DateTo || r.DateFrom);
      if (rf && rt && !(to < rf || from > rt)) {
        throw new Error('มีคำขอ ' + type + ' ที่ ' + st + ' อยู่แล้วในช่วงวันดังกล่าว (' + r.ReqID + ')');
      }
    }
    var now = _nowStamp();
    var rec = {
      ReqID:    _attNextReqId(data.rows, type, _stampDate(now)),
      Type:     type,
      EmpID:    empId,
      Name:     (person.n + ' ' + person.ln).trim(),
      Vendor:   person.vendor || '',
      Team:     person.t || '',
      SubType:  subType,
      DateFrom: from,
      DateTo:   to,
      Days:     days.length,
      Hours:    hours || '',
      TimeFrom: body.timeFrom ? _toHHMM(body.timeFrom) : '',
      TimeTo:   body.timeTo   ? _toHHMM(body.timeTo)   : '',
      Reason:   reason,
      Status:   'PENDING',
      CreatedAt: now,
      CreatedBy: actor
    };
    _attAppend(sh, data.header.length ? data.header : REQUEST_HEADERS, rec);
    _log(actor, 'submitRequest', rec.ReqID + ' ' + empId + ' ' + from + '..' + to);
    return {ok: true, reqId: rec.ReqID, request: pullRequests({empId: empId})[0] || null};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// Roster writes done inside an already-held lock (saveRoster takes its own).
function _rosterApplyNoLock(cells, actor) {
  if (!cells.length) return {};
  var sh = _getOrCreateRosterSheet();
  var values = sh.getDataRange().getValues();
  var rowByKey = {}, codeByKey = {};
  for (var r = 1; r < values.length; r++) {
    var k = String(values[r][0] || '').trim();
    if (k) { rowByKey[k] = r + 1; codeByKey[k] = String(values[r][1] || '').trim(); }
  }
  var now = _nowStamp(), appendRows = [], deleteRows = [], prev = {};
  cells.forEach(function(c){
    var key = String(c.key || '').trim();
    if (!key) return;
    prev[key] = codeByKey[key] || '';
    var code = c.code == null ? '' : String(c.code).trim();
    if (code === '') { if (rowByKey[key]) deleteRows.push(rowByKey[key]); }
    else if (rowByKey[key]) sh.getRange(rowByKey[key], 1, 1, 4).setValues([[key, code, now, actor]]);
    else appendRows.push([key, code, now, actor]);
  });
  if (appendRows.length) sh.getRange(sh.getLastRow() + 1, 1, appendRows.length, 4).setValues(appendRows);
  deleteRows.sort(function(a,b){ return b - a; }).forEach(function(rw){ sh.deleteRow(rw); });
  return prev;
}

// body: {reqId, decision:'APPROVE'|'REJECT', note?}
function decideRequest(body) {
  body = body || {};
  var actor = _me();
  _attAssertWriter(actor);
  var reqId    = String(body.reqId || '').trim();
  var decision = String(body.decision || '').toUpperCase();
  if (!reqId) throw new Error('ต้องระบุ reqId');
  if (decision !== 'APPROVE' && decision !== 'REJECT') throw new Error('decision ต้องเป็น APPROVE หรือ REJECT');

  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var sh   = _attTab(ATT.REQUEST_TAB, REQUEST_HEADERS);
    var data = _attRows(sh);
    var rec = null;
    for (var i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i].ReqID || '').trim() === reqId) { rec = data.rows[i]; break; }
    }
    if (!rec) throw new Error('ไม่พบคำขอ ' + reqId);
    var empId = String(rec.EmpID || '').replace(/\.0$/,'').trim();
    if (_attEmpIdForEmail(actor) === empId) throw new Error('อนุมัติคำขอของตัวเองไม่ได้');
    var status = String(rec.Status || '').toUpperCase();
    if (status === 'CANCELLED') throw new Error('คำขอถูกยกเลิกแล้ว');

    var type = String(rec.Type || '').toUpperCase();
    var from = _toISO(rec.DateFrom), to = _toISO(rec.DateTo || rec.DateFrom);
    var days = _dateRange(from, to);
    var prevCodes = rec.PrevCodes ? JSON.parse(String(rec.PrevCodes)) : null;

    if (type === 'LEAVE') {
      var team = String(rec.Team || '').trim().toUpperCase();
      if (!team) throw new Error('พนักงานยังไม่มีทีม — กำหนด Team ใน Outsource tab ก่อนอนุมัติลา');
      if (decision === 'APPROVE' && status !== 'APPROVED') {
        // stamp the leave code into the roster; remember what it replaced
        var cells = days.map(function(d){ return {key: team + '-' + d + '-' + empId, code: rec.SubType}; });
        var prev = _rosterApplyNoLock(cells, actor);
        rec.PrevCodes = JSON.stringify(prev);
      } else if (decision === 'REJECT' && status === 'APPROVED' && prevCodes) {
        // approval being reversed — put the original shift codes back
        var restore = Object.keys(prevCodes).map(function(k){ return {key: k, code: prevCodes[k]}; });
        _rosterApplyNoLock(restore, actor);
        rec.PrevCodes = '';
      }
    }

    rec.Status     = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
    rec.DecidedAt  = _nowStamp();
    rec.DecidedBy  = actor;
    rec.DecideNote = String(body.note || '').slice(0, 300);
    _attWrite(sh, data.header, rec._row, rec);

    // OT approval changes the approved-hours baseline on those days
    if (type === 'OT') _attRefreshDays(empId, days, actor);

    _log(actor, 'decideRequest', reqId + ' → ' + rec.Status);
    return {ok: true, reqId: reqId, status: rec.Status};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// body: {reqId}
function cancelRequest(body) {
  body = body || {};
  var actor = _me();
  var reqId = String(body.reqId || '').trim();
  if (!reqId) throw new Error('ต้องระบุ reqId');

  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var sh   = _attTab(ATT.REQUEST_TAB, REQUEST_HEADERS);
    var data = _attRows(sh);
    var rec = null;
    for (var i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i].ReqID || '').trim() === reqId) { rec = data.rows[i]; break; }
    }
    if (!rec) throw new Error('ไม่พบคำขอ ' + reqId);
    var empId = String(rec.EmpID || '').replace(/\.0$/,'').trim();
    var owner = String(rec.CreatedBy || '').toLowerCase() === String(actor).toLowerCase()
             || _attEmpIdForEmail(actor) === empId;
    if (!owner && !isAuthorized(actor)) throw new Error('ยกเลิกได้เฉพาะผู้ยื่นคำขอหรือผู้มีสิทธิ์');
    var status = String(rec.Status || '').toUpperCase();
    if (status === 'CANCELLED') return {ok: true, reqId: reqId, status: status};
    if (status === 'APPROVED' && !isAuthorized(actor)) {
      throw new Error('คำขอที่อนุมัติแล้ว ยกเลิกได้เฉพาะผู้มีสิทธิ์');
    }
    if (status === 'APPROVED' && String(rec.Type||'').toUpperCase() === 'LEAVE' && rec.PrevCodes) {
      var prevCodes = JSON.parse(String(rec.PrevCodes));
      _rosterApplyNoLock(Object.keys(prevCodes).map(function(k){
        return {key: k, code: prevCodes[k]};
      }), actor);
      rec.PrevCodes = '';
    }
    rec.Status     = 'CANCELLED';
    rec.DecidedAt  = _nowStamp();
    rec.DecidedBy  = actor;
    rec.DecideNote = 'cancelled';
    _attWrite(sh, data.header, rec._row, rec);
    if (String(rec.Type||'').toUpperCase() === 'OT') {
      _attRefreshDays(empId, _dateRange(_toISO(rec.DateFrom), _toISO(rec.DateTo || rec.DateFrom)), actor);
    }
    _log(actor, 'cancelRequest', reqId);
    return {ok: true, reqId: reqId, status: 'CANCELLED'};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// Recompute existing attendance rows for one person on given dates
// (called when approved-OT hours change). Caller holds the lock.
function _attRefreshDays(empId, days, actor) {
  if (!days || !days.length) return;
  var sh   = _attTab(ATT.ATTENDANCE_TAB, ATTENDANCE_HEADERS);
  var data = _attRows(sh);
  if (!data.rows.length) return;
  var roster = pullRoster(), otMap = _approvedOtMap(), want = {};
  days.forEach(function(d){ want[d] = 1; });
  data.rows.forEach(function(rec){
    var d = _toISO(rec.Date);
    if (!want[d]) return;
    if (String(rec.EmpID||'').replace(/\.0$/,'').trim() !== empId) return;
    rec.InAt = _toStamp(rec.InAt); rec.OutAt = _toStamp(rec.OutAt);
    rec.UpdatedAt = _nowStamp(); rec.UpdatedBy = actor;
    _attRecalc(rec, roster, otMap[empId + '|' + d] || 0);
    _attWrite(sh, data.header, rec._row, rec);
  });
}

// ── WRITE — Outsource registry ────────────────────────────────────────
// body: {staff:[{i,n,ln,nth,vendor,t,p,phone,email,start,end,active,note}],
//        remove:['empId', …]}
function saveOutsourceStaff(body) {
  body = body || {};
  var actor = _me();
  _attAssertWriter(actor);
  var list   = body.staff || [];
  var remove = body.remove || [];
  if (!list.length && !remove.length) return {ok: true, n: 0};

  var lock = _acquireLock();
  if (!lock || !lock.tryLock(8000)) throw new Error('busy — another write in progress, retry');
  try {
    var sh   = _attTab(ATT.OUTSOURCE_TAB, OUTSOURCE_HEADERS);
    var data = _attRows(sh);
    var header = data.header.length ? data.header : OUTSOURCE_HEADERS;
    var rowById = {};
    data.rows.forEach(function(r){
      var id = String(r.EmpID || '').replace(/\.0$/,'').trim();
      if (id) rowById[id] = r;
    });
    var now = _nowStamp(), n = 0;

    list.forEach(function(s){
      var id = String(s.i || s.empId || '').trim();
      if (!id) return;
      if (!String(s.n || '').trim()) throw new Error('รหัส ' + id + ': ต้องระบุชื่อ');
      if (!String(s.t || '').trim()) throw new Error('รหัส ' + id + ': ต้องระบุทีม (ใช้เขียน roster/ลา)');
      var rec = rowById[id] || {EmpID: id};
      rec.EmpID     = id;
      rec.Name      = String(s.n || '').trim();
      rec.Surname   = String(s.ln || '').trim();
      rec.NameTh    = String(s.nth || '').trim();
      rec.Vendor    = String(s.vendor || '').trim();
      rec.Team      = String(s.t || '').trim().toUpperCase();
      rec.Position  = String(s.p || 'PSA').trim().toUpperCase();
      rec.Phone     = String(s.phone || '').trim();
      rec.Email     = String(s.email || '').trim().toLowerCase();
      rec.StartDate = _toISO(s.start);
      rec.EndDate   = _toISO(s.end);
      rec.Active    = (s.active === false || s.active === 'no') ? 'No' : 'Yes';
      rec.Note      = String(s.note || '').trim().slice(0, 300);
      rec.UpdatedAt = now;
      rec.UpdatedBy = actor;
      if (rowById[id]) _attWrite(sh, header, rec._row, rec);
      else _attAppend(sh, header, rec);
      n++;
    });

    // delete bottom-up so row indices stay valid
    var rows = [];
    remove.forEach(function(id){
      var r = rowById[String(id).trim()];
      if (r) rows.push(r._row);
    });
    rows.sort(function(a,b){ return b - a; }).forEach(function(rw){ sh.deleteRow(rw); n++; });

    _log(actor, 'saveOutsourceStaff', n + ' rows (' + remove.length + ' removed)');
    return {ok: true, n: n, outsource: pullOutsource()};
  } finally { try { lock.releaseLock(); } catch (e) {} }
}


// ── Import the vendor (outsource) monthly labor workbook ──────────────
// e.g. "Jan - May 2026Globex.xlsx": one tab per month; each employee is a
// block of rows — 'กะการทำงาน' (shift, as time ranges "08-17"/OFF/X) then
// แรงงานปฏิบัติงาน / ขาดส่งแรง / สาย / OT1.5 / OT1 / OT3 / หมายเหตุ.
// READ-ONLY like importRosterFromDrive: returns {staff, cells, ot} for the
// client to merge — registry via saveOutsourceStaff, shifts via roster sync.
//   body: {fileId, sheet?, team?, vendor?, year?}
function importOutsourceFromDrive(body) {
  body = body || {};
  var srcId = body.fileId || '';
  if (!srcId) throw new Error('importOutsourceFromDrive: ต้องระบุ fileId');
  var team = String(body.team || 'OUT').trim().toUpperCase();

  var ss;
  try { ss = SpreadsheetApp.openById(srcId); }
  catch (e) {
    // xlsx in Drive can't be opened by SpreadsheetApp — convert if the
    // advanced Drive service is on, else tell the admin what to do.
    if (typeof Drive !== 'undefined' && Drive.Files && Drive.Files.copy) {
      var copy = Drive.Files.copy(
        {title: '[import] outsource ' + _todayISO(), mimeType: 'application/vnd.google-apps.spreadsheet'},
        srcId);
      ss = SpreadsheetApp.openById(copy.id);
    } else {
      throw new Error('เปิดไฟล์ไม่ได้ (' + (e.message || e) + ') — ถ้าเป็น .xlsx ให้เปิดใน Google Sheets แล้ว File → Save as Google Sheets ก่อน แล้วใช้ id ของไฟล์ใหม่');
    }
  }

  var wantSheet = String(body.sheet || '').trim().toLowerCase();
  var sheets = ss.getSheets().filter(function(sh){
    return !wantSheet || sh.getName().trim().toLowerCase() === wantSheet;
  });
  if (!sheets.length) throw new Error('ไม่พบแท็บ "' + body.sheet + '" — มี: ' +
    ss.getSheets().map(function(s){return s.getName();}).join(', '));

  var SHIFT_LABEL = 'กะการทำงาน';
  var OT_KIND = [[/^OT\s*1\.5/i,'ot15'], [/^OT\s*1(?![.\d])/i,'ot1'],
                 [/^OT\s*3/i,'ot3'], [/^OT\s*4/i,'ot4'],
                 [/^OT\s*(OFF|DAYOFF)/i,'ot1']];

  var vendor = String(body.vendor || '').trim();
  var staffById = {}, cells = [], seenKey = {}, otRows = [], perSheet = [];

  sheets.forEach(function(sh){
    var values;
    try { values = sh.getDataRange().getValues(); }
    catch (e) { perSheet.push({sheet: sh.getName(), error: String(e.message || e)}); return; }
    if (!values.length) return;

    // year: a cell whose year is Buddhist (>=2400 → -543) or Gregorian
    // (>=2020); Excel's 1900-epoch date headers are ignored for year.
    var year = parseInt(body.year, 10) || 0;
    for (var r = 0; !year && r < Math.min(4, values.length); r++) {
      for (var c = 0; c < values[r].length; c++) {
        var v = values[r][c];
        if (v instanceof Date && !isNaN(v)) {
          var y = v.getFullYear();
          if (y >= 2400) { year = y - 543; break; }
          if (y >= 2020) { year = y; break; }
        }
        if (!vendor && typeof v === 'string' && /บริษัท/.test(v)) vendor = v.trim();
      }
    }
    if (!year) year = new Date().getFullYear();

    // date-header row: the one with the most date-like cells (Date objects
    // or "1-Jan" text); each such column maps to an ISO date.
    var dateCols = null, bestCount = 0;
    var MO = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
    for (var hr = 0; hr < Math.min(8, values.length); hr++) {
      var cols = {}, count = 0;
      for (var hc = 0; hc < values[hr].length; hc++) {
        var hv = values[hr][hc], mo = 0, dd = 0;
        if (hv instanceof Date && !isNaN(hv)) { mo = hv.getMonth() + 1; dd = hv.getDate(); }
        else if (typeof hv === 'string') {
          var hm = hv.trim().toUpperCase().match(/^(\d{1,2})[-\/ ]([A-Z]{3})/);
          if (hm && MO[hm[2]]) { dd = +hm[1]; mo = MO[hm[2]]; }
        }
        if (mo && dd) { cols[hc] = year + '-' + _p(mo) + '-' + _p(dd); count++; }
      }
      if (count >= 5 && count > bestCount) { bestCount = count; dateCols = cols; }
    }
    if (!dateCols) { perSheet.push({sheet: sh.getName(), error: 'no date header row'}); return; }

    var nStaff = 0, nCells = 0;
    for (var row = 0; row < values.length; row++) {
      var labelCol = -1;
      for (var lc = 0; lc < Math.min(8, values[row].length); lc++) {
        if (String(values[row][lc] || '').trim() === SHIFT_LABEL) { labelCol = lc; break; }
      }
      if (labelCol < 0) continue;

      // identity cells sit left of the label on the same row
      var empId = '', emp2 = '', name = '';
      for (var ic = 0; ic < labelCol; ic++) {
        var iv = values[row][ic];
        var s = String(iv == null ? '' : iv).replace(/\.0$/, '').trim();
        if (/^\d{6}$/.test(s) && !empId) empId = s;
        else if (/^\d{7}$/.test(s)) emp2 = s;
        else if (s && !/^\d+$/.test(s) && s.length > name.length) name = s;
      }
      if (!empId) continue;

      if (!staffById[empId]) {
        // "นางสาวขวัญนภา นิจคำ" → title stays in the Thai name; EN split n/a
        staffById[empId] = {i: empId, n: name || empId, ln: '', nth: name,
                            vendor: vendor, t: team, p: 'PSA', note: emp2 ? 'EMP2#: ' + emp2 : ''};
        nStaff++;
      }

      // shift row → roster cells
      Object.keys(dateCols).forEach(function(dc){
        var code = String(values[row][dc] == null ? '' : values[row][dc]).trim();
        if (!code) return;
        var key = team + '-' + dateCols[dc] + '-' + empId;
        if (seenKey[key]) return; seenKey[key] = 1;
        cells.push({key: key, code: code});
        nCells++;
      });

      // OT / late rows in the rest of the block (until the next block)
      for (var br = row + 1; br < Math.min(row + 9, values.length); br++) {
        var lab = String(values[br][labelCol] || '').trim();
        if (lab === SHIFT_LABEL) break;
        var kind = '';
        for (var k = 0; k < OT_KIND.length; k++) if (OT_KIND[k][0].test(lab)) { kind = OT_KIND[k][1]; break; }
        if (!kind && /สาย/.test(lab)) kind = 'late';
        if (!kind) continue;
        Object.keys(dateCols).forEach(function(dc){
          var n = parseFloat(values[br][dc]);
          if (!n || isNaN(n)) return;
          otRows.push({empId: empId, date: dateCols[dc], kind: kind, hrs: n});
        });
      }
    }
    perSheet.push({sheet: sh.getName(), year: year, staff: nStaff, cells: nCells});
  });

  var staff = Object.keys(staffById).map(function(k){ return staffById[k]; });
  return {ok: true, fileId: srcId, team: team, vendor: vendor,
          staff: staff, cells: cells, ot: otRows,
          staffCount: staff.length, n: cells.length, otCount: otRows.length,
          sheets: perSheet};
}

// ── Range summary (report tab / payroll hand-off) ─────────────────────
function attendanceSummary(from, to, team) {
  var f = _toISO(from) || _todayISO();
  var t = _toISO(to) || f;
  var recs = pullAttendance(f, t);
  var reqs = pullRequests({from: f, to: t});
  var byEmp = {};

  function slot(id, r) {
    if (!byEmp[id]) {
      byEmp[id] = {empId: id, name: r.name || '', vendor: r.vendor || '', team: r.team || '',
                   days: 0, workHrs: 0, otHrs: 0, otApproved: 0, late: 0, earlyOut: 0,
                   noOut: 0, otUnapproved: 0, leaveDays: 0};
    }
    return byEmp[id];
  }

  recs.forEach(function(r){
    if (team && team !== 'ALL' && r.team !== team) return;
    var e = slot(r.empId, r);
    if (!e.name && r.name) e.name = r.name;
    e.days++;
    e.workHrs    += r.workHrs || 0;
    e.otHrs      += r.otHrs || 0;
    e.otApproved += r.otApproved || 0;
    if (r.flags.indexOf('LATE') >= 0)           e.late++;
    if (r.flags.indexOf('EARLY_OUT') >= 0)      e.earlyOut++;
    if (r.flags.indexOf('NO_OUT') >= 0)         e.noOut++;
    if (r.flags.indexOf('OT_UNAPPROVED') >= 0)  e.otUnapproved++;
  });

  reqs.forEach(function(q){
    if (q.type !== 'LEAVE' || q.status !== 'APPROVED') return;
    if (team && team !== 'ALL' && q.team !== team) return;
    var e = slot(q.empId, q);
    if (!e.name && q.name) e.name = q.name;
    e.leaveDays += _dateRange(
      q.dateFrom < f ? f : q.dateFrom,
      q.dateTo   > t ? t : q.dateTo).length;
  });

  var out = Object.keys(byEmp).map(function(k){
    var e = byEmp[k];
    e.workHrs    = Math.round(e.workHrs * 100) / 100;
    e.otHrs      = Math.round(e.otHrs * 100) / 100;
    e.otApproved = Math.round(e.otApproved * 100) / 100;
    return e;
  });
  out.sort(function(a,b){ return b.otHrs - a.otHrs || (a.name < b.name ? -1 : 1); });
  return {from: f, to: t, team: team || 'ALL', rows: out};
}

// ───────────────────────────────────────────────────────────────────────
// Manual test helpers — run from Apps Script editor for quick checks
// ───────────────────────────────────────────────────────────────────────
function TEST_pullStaff()       { Logger.log(JSON.stringify(pullStaff().slice(0,5), null, 2)); }
function TEST_pullFlights()     { Logger.log(JSON.stringify(pullFlights(_todayISO()).slice(0,5), null, 2)); }
function TEST_pullAssignments() { Logger.log(JSON.stringify(pullAssignments(_todayISO()), null, 2)); }
function TEST_me()              { Logger.log(_me() + ' authorized=' + isAuthorized(_me())); }
function TEST_outsource()       { Logger.log(JSON.stringify(pullOutsource().slice(0,5), null, 2)); }
function TEST_attendance()      { Logger.log(JSON.stringify(pullAttendance(_todayISO()), null, 2)); }
function TEST_requests()        { Logger.log(JSON.stringify(pullRequests({status:'PENDING'}), null, 2)); }
function TEST_attBootstrap()    { var d = attendanceBootstrap(_todayISO());
  Logger.log('me=' + d.me + ' canWrite=' + d.canWrite + ' myEmpId=' + d.myEmpId
           + ' outsource=' + d.outsource.length + ' att=' + d.attendance.length
           + ' req=' + d.requests.length); }
function TEST_attSummary()      { Logger.log(JSON.stringify(attendanceSummary(_todayISO(), _todayISO()), null, 2)); }
function TEST_writeOne() {
  var r = upsertAssignment({
    date:'2026-05-13', team:'EK', flight:'EK374', role:'SUP', slot:0,
    empId:'2000819', empName:'Rungsinee'
  }, _me());
  Logger.log(JSON.stringify(r));
}
function TEST_autoAssign() {
  var r = autoAssignDay({date:_todayISO(), team:'EK'}, _me());
  Logger.log(JSON.stringify(r, null, 2));
}
function TEST_autoAssignAll() {
  var r = autoAssignDay({date:_todayISO()}, _me());
  Logger.log('assigned='+r.assigned+' violations='+r.violations.length+' flights='+r.flightsProcessed);
  Logger.log(JSON.stringify(r.violations.slice(0,10), null, 2));
}
