// Import templates, one per carrier shape.
//
// A template is not just a header row. It is the place to encode the things a person filling the
// sheet in cannot be expected to remember: that the service address is the customer's address and
// not the one the carrier bills, that a Verizon sub-account groups several customers while a Cox
// account is one address, and that leaving the sell price blank makes P&L read the account as a
// total loss. Each one therefore ships with worked example rows and an instructions sheet.
//
// Every header here is one the column detector recognises, so a filled-in template maps with no
// correction. That is a real coupling: lib/colmap.js and this file have to agree, and the test
// suite asserts it rather than trusting it.
import { writeXlsx } from './xlsxwrite.js';

const SHARED_NOTES = [
  ['Filling this in', ''],
  ['One row per service', 'Each row is one internet service at one location. Leave a cell blank if you do not know it — blank is fine, a guess is not.'],
  ['Nothing is saved on upload', 'The wizard shows you how it read every column and what every row will do. Nothing is written until you press Import.'],
  ['You can re-upload the same file', 'Rows that already exist are recognised and linked rather than duplicated, so a corrected file can be uploaded again safely.'],
  ['Every import can be undone', 'Settings → Import a spreadsheet → Past imports. Records that have been built on since are kept, and it tells you which.'],
  ['', ''],
  ['Addresses', ''],
  ['Service Address', 'Where the equipment physically is. This becomes the Site, and hardware attaches to it. For an apartment or suite, put the unit in its own column — several units at one street address become one building with units, not several sites.'],
  ['Account Address (carrier)', 'Whatever address the carrier has on the account, if it differs. Stored on the account for reference only; it never becomes a Site.'],
  ['', ''],
  ['Money', ''],
  ['Monthly Cost', 'What you pay the carrier.'],
  ['Monthly Price', 'What you bill the customer. Leave it blank and the P&L page shows the account at a full loss, because there is no revenue to set against the cost.'],
  ['', ''],
  ['Credentials', ''],
  ['Portal Username / Password / PIN', 'Stored in the account’s credential fields, visible only to NOC and admin, and never shown in search or lists. The import preview masks them on screen. If you would rather not put them in a file at all, leave the columns out and add them on the account page.'],
  ['', ''],
  ['Formats it accepts', ''],
  ['MAC address', 'With or without separators: 1C937CF4A003 and 1c:93:7c:f4:a0:03 are both read, and both stored as 1C:93:7C:F4:A0:03.'],
  ['Bill Due Day', 'A day of the month. "17", "17th" and "the 17th" all work.'],
  ['Autopay', 'Yes / No / Y / N / true / false. Blank means unknown, which is not the same as No.'],
  ['Plan', 'Free text. Common spellings are folded together, so "1 gig", "1gig" and "gigablast" all become one plan.']
];

function notesSheet(title, intro, extra = []) {
  return {
    name: 'How to use',
    widths: [30, 96],
    rows: [
      [{ v: title, style: 'title' }],
      [{ v: intro, style: 'wrap' }],
      [''],
      ...extra.map(([a, b]) => [a ? { v: a, style: 'wrap' } : '', b ? { v: b, style: 'wrap' } : '']),
      [''],
      ...SHARED_NOTES.map(([a, b]) => [a ? { v: a, style: 'wrap' } : '', b ? { v: b, style: 'wrap' } : ''])
    ]
  };
}

// ---- Cox: one account per address ----
const COX = {
  key: 'cox',
  label: 'Cox — one account per address',
  filename: 'Cox accounts — import template.xlsx',
  headers: ['Customer / Business Name', 'Service Address', 'Unit', 'Carrier', 'Account Number',
    'Account Address', 'Plan', 'Monthly Cost', 'Monthly Price', 'Bill Due Day', 'Autopay',
    'Payment Method', 'Serial Number', 'MAC Address', 'Model', 'Email', 'Phone',
    'Portal Username', 'Portal Password', 'Account PIN', 'Notes'],
  widths: [26, 38, 8, 12, 20, 34, 20, 13, 14, 11, 9, 20, 22, 20, 20, 24, 15, 18, 18, 11, 34],
  examples: [
    ['Alex Canales', '4356 E Grove St, Phoenix, AZ 85040', '', 'Cox', '8502065851706',
      '2929 E Main St Lot 616, Mesa, AZ 85213', 'StraightUp 50', 50, 89.99, '2nd', 'No',
      'Privacy card', '2CG5J1699600741', '1C937CF4A003', 'MikroTik L009UiGS-RM', 'alex@example.com', '602-555-0142',
      'gtek616', 'change-me', '0501', 'Cox account address is the old service address'],
    ['Judith Quezada', '6901 W McDowell Rd, Phoenix, AZ 85035', 'Apt 13206', 'Cox', '8501196769204',
      '', 'Gigablast', 80, 129.99, '7th', 'Yes',
      'BOA card', '9BV3J1685602501', '14C03E07C589', 'MikroTik hAP ax2', '', '',
      '3152gtek', 'change-me', '0501', 'Moved from 6161 W McDowell Rd Apt 1044']
  ],
  intro: 'One row per Cox account. Cox opens one account per service address, so account number, '
    + 'address, equipment and customer all belong on the same row.',
  extra: [
    ['Cox specifics', ''],
    ['Account Number', 'The 13-digit Cox account number. It identifies the account on re-import, so keep it exact — including any leading zero.'],
    ['One account, one address', 'If the same account number appears on two rows, the wizard treats it as one account rather than creating it twice.'],
    ['Unit', 'For an apartment or suite, put the unit here and the plain street address in Service Address. Several units at one address become one building with units.']
  ]
};

// ---- Verizon: a sub-account groups several customers ----
const VERIZON = {
  key: 'verizon',
  label: 'Verizon — sub-accounts grouping several customers',
  filename: 'Verizon accounts — import template.xlsx',
  headers: ['Customer / Business Name', 'Service Address', 'Unit', 'Carrier', 'Account Name',
    'Account Number', 'Sub-Account', 'Plan', 'Monthly Cost', 'Monthly Price', 'Bill Due Day',
    'Autopay', 'Payment Method', 'Serial Number', 'MAC Address', 'Model', 'Email', 'Phone',
    'Portal Username', 'Portal Password', 'Account PIN', 'Notes'],
  widths: [26, 38, 8, 12, 24, 20, 20, 20, 13, 14, 11, 9, 20, 22, 20, 20, 24, 15, 18, 18, 11, 34],
  examples: [
    ['Sunrise Dental', '1400 W Elliot Rd, Tempe, AZ 85284', 'Ste 100', 'Verizon', 'GEEKFILTE LLC',
      '942797643', 'Elliot Rd building', 'Business Internet 500', 120, 199.99, '15th',
      'Yes', 'BOA ACH', 'VZ-SN-000121', 'A4:2B:B0:11:22:33', 'MikroTik hAP ax3', 'billing@sunrisedental.example', '480-555-0110',
      'geekfilte-vz', 'change-me', '4417', ''],
    ['Elliot Rd Chiropractic', '1400 W Elliot Rd, Tempe, AZ 85284', 'Ste 210', 'Verizon', 'GEEKFILTE LLC',
      '942797643', 'Elliot Rd building', 'Business Internet 500', 120, 189.99, '15th',
      'Yes', 'BOA ACH', 'VZ-SN-000122', 'A4:2B:B0:11:22:34', 'MikroTik hAP ax3', '', '',
      '', '', '', 'Second tenant on the same sub-account and the same building'],
    ['Vista Property Mgmt', '900 N Tower Rd, Mesa, AZ 85201', '', 'Verizon', 'GEEKFILTE LLC',
      '942797643', 'Tower Rd building', 'Business Internet 1G', 250, 399.99, '15th',
      'Yes', 'BOA ACH', 'VZ-SN-000140', 'A4:2B:B0:11:22:40', 'MikroTik CCR2004', 'ap@vista.example', '480-555-0188',
      '', '', '', 'Different sub-account, same master account']
  ],
  intro: 'One row per customer. Verizon runs a master account with sub-accounts underneath it, and '
    + 'a sub-account can carry several customers — so the account number repeats down the sheet and '
    + 'the Sub-Account column is what separates the groups.',
  extra: [
    ['Verizon specifics', ''],
    ['Account Name + Account Number', 'The master account, repeated on every row that belongs to it. Repeating it does not create it twice.'],
    ['Sub-Account', 'The group the customer sits under — a building, a reseller, a region, whatever Verizon calls it. Several customers can share one sub-account; write it identically on each of their rows so they group together.'],
    ['Two customers, one building', 'Give them the same Service Address and different Units. They become one building with two units, each linked to its own customer, rather than two sites at the same address.'],
    ['Cost on repeated rows', 'Monthly Cost is a property of the account, so the first row that carries it wins. Put the true carrier cost on the first row of each account and leave it blank below, or repeat it — either works.']
  ]
};

// ---- Generic ----
const GENERIC = {
  key: 'generic',
  label: 'Generic — any carrier',
  filename: 'Accounts — import template.xlsx',
  headers: ['Customer / Business Name', 'Service Address', 'Unit', 'Carrier', 'Account Name',
    'Account Number', 'Sub-Account', 'Plan', 'Monthly Cost', 'Monthly Price', 'Bill Due Day',
    'Autopay', 'Payment Method', 'Serial Number', 'MAC Address', 'Model', 'Email', 'Phone',
    'Install Date', 'Notes'],
  widths: [26, 38, 8, 14, 24, 20, 18, 20, 13, 14, 11, 9, 20, 22, 20, 20, 24, 15, 13, 34],
  examples: [
    ['Example Customer LLC', '123 Example Ave, Phoenix, AZ 85001', '', 'Lumen', 'Example Master Account',
      'ACCT-100200', '', 'Dedicated 100M', 300, 549, '1st', 'Yes', 'ACH', 'SN-0001', 'B8:27:EB:00:11:22',
      'MikroTik CCR2004', 'ap@example.com', '602-555-0100', '2026-01-15', '']
  ],
  intro: 'A starting point for any carrier. Delete the columns you do not use — the wizard only '
    + 'imports the ones you keep, and unrecognised columns are simply ignored.',
  extra: [
    ['Which columns are required?', 'None are, strictly. But a row with no customer name and no address cannot create anything, and the wizard will tell you so before you import.'],
    ['Sub-Account', 'Only if your carrier uses them. Leave the column empty otherwise.']
  ]
};

export const TEMPLATES = [COX, VERIZON, GENERIC];
export const templateByKey = k => TEMPLATES.find(t => t.key === k) || null;

/** Header row, worked examples, and an instructions sheet. */
export function buildTemplate(key) {
  const t = templateByKey(key);
  if (!t) return null;
  return {
    filename: t.filename,
    buffer: writeXlsx([
      {
        name: 'Accounts',
        headerRow: true,
        freezeHeader: true,
        widths: t.widths,
        // The examples are real-shaped rows, left in on purpose: an empty template invites
        // guesswork about format, and it is easier to overwrite a row than to invent one.
        rows: [t.headers, ...t.examples]
      },
      notesSheet(t.label, t.intro, t.extra)
    ])
  };
}
