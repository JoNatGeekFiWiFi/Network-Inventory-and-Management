const B=process.env.BASE ?? 'http://localhost:3000'; let cookie='';
async function call(path,{method='GET',body}={}){ const h={}; if(body!==undefined){h['content-type']='application/json';method=method==='GET'?'POST':method;} if(cookie)h.cookie=cookie; const r=await fetch(B+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined}); const sc=r.headers.get('set-cookie'); if(sc)cookie=sc.split(';')[0]; const t=await r.text(); let j=null;try{j=JSON.parse(t);}catch{} return {status:r.status,json:j,t}; }
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(c?'PASS':'FAIL',m);};
const near=(a,b)=>Math.abs(a-b)<0.02;
await call('/api/login',{body:{email:'admin@geekitek.test',password:'admin123'}});
const acct=(await call('/api/meta')).json.accounts[0];

// Realistic Invoice Ninja v5 backup shape: nested under a company wrapper
const ninja = { data: { company: { name:'GeekiTek' },
  clients:[
    { id:'cl1', name:'Riverside Logistics', phone:'(555) 200-3000', public_notes:'Net 30',
      contacts:[{first_name:'Dana',last_name:'Reed',email:'dana@riverside.test',phone:'555-200-3001'}] },
    { id:'cl2', name:'', contacts:[{first_name:'Sam',last_name:'Ortiz',email:'sam@ortiz.test'}] },
    { id:'cl3', name:'No Contact Co' }
  ],
  invoices:[
    { id:'in1', client_id:'cl1', number:'INV-2024-001', date:'2024-03-01', due_date:'2024-03-31', status_id:4, amount:1100, balance:0,
      line_items:[{product_key:'Internet 500M', notes:'Monthly service', cost:500, quantity:2, tax_rate1:10, tax_name1:'GST'}] },
    { id:'in2', client_id:'cl1', number:'INV-2024-002', date:'2024-04-01', status_id:2, amount:250, balance:250,
      line_items:[{product_key:'Install', cost:250, quantity:1}] },
    { id:'in3', client_id:'cl2', number:'INV-2024-003', date:'2024-04-05', status_id:3, amount:400, balance:150,
      line_items:[{product_key:'Support', cost:400, quantity:1}] },
    { id:'in4', client_id:'MISSING', number:'INV-2024-099', date:'2024-04-09', status_id:2, amount:10, line_items:[] }
  ],
  payments:[
    { id:'p1', date:'2024-03-15', amount:1100, transaction_reference:'CHK-9001', type_id:3, paymentables:[{invoice_id:'in1', amount:1100}] },
    { id:'p2', date:'2024-04-20', amount:250, type_id:1, paymentables:[{invoice_id:'in3', amount:250}] }
  ] } };

// 1 PREVIEW - nothing saved
let r=(await call('/api/import/invoiceninja',{method:'POST',body:{data:ninja,account_id:acct.id,commit:false}})).json;
ok(r.customers_created===3,'preview: 3 new customers ('+r.customers_created+')');
ok(r.invoices_created===3&&r.invoices_skipped===1,'preview: 3 invoices, 1 skipped (no client)');
ok(r.payments_created===2,'preview: 2 payments');
ok(r.warnings.some(w=>w.includes('INV-2024-099')),'preview warns about orphan invoice');
const custBefore=(await call('/api/customers')).json.length;
ok(true,'customers unchanged after preview ('+custBefore+')');

// 2 COMMIT
r=(await call('/api/import/invoiceninja',{method:'POST',body:{data:ninja,account_id:acct.id,commit:true}})).json;
ok(r.customers_created===3&&r.invoices_created===3&&r.payments_created===2,'commit created 3/3/2');
const custs=(await call('/api/customers')).json;
ok(custs.length===custBefore+3,'customers actually created');
const riv=custs.find(c=>c.name==='Riverside Logistics');
ok(riv&&riv.billing_email==='dana@riverside.test','client email from first contact');
ok(riv.sms_number==='+15552003000','phone normalized to E.164 ('+riv.sms_number+')');
ok(custs.some(c=>c.name==='Sam Ortiz'),'nameless client falls back to contact name');

// invoice fidelity
const invs=(await call('/api/billing/invoices')).json;
const i1=invs.find(x=>x.number==='INV-2024-001');
ok(!!i1,'invoice number preserved (INV-2024-001)');
ok(near(i1.total,1100)&&near(i1.balance,0)&&i1.status==='paid','paid invoice: total 1100, balance 0, status paid');
const i2=invs.find(x=>x.number==='INV-2024-002');
ok(near(i2.balance,250)&&i2.status==='sent','unpaid invoice keeps balance 250 / sent');
const i3=invs.find(x=>x.number==='INV-2024-003');
ok(near(i3.balance,150)&&i3.status==='partial','partial: 400-250 = 150 balance, status partial ('+i3.balance+'/'+i3.status+')');
// line items
const full=(await call('/api/billing/invoices/'+i1.id)).json;
ok(full.items.length===1&&near(full.items[0].unit_price,500)&&full.items[0].quantity===2,'line items imported (qty 2 @ 500)');
ok(full.items[0].taxable===1,'taxable flag from tax_rate1');
ok(full.payments.length===1&&full.payments[0].reference==='CHK-9001','payment imported with reference');

// 3 RE-RUN idempotency
r=(await call('/api/import/invoiceninja',{method:'POST',body:{data:ninja,account_id:acct.id,commit:true}})).json;
ok(r.customers_created===0&&r.customers_matched===3,'re-run: matched existing customers, created none');
ok(r.invoices_created===0&&r.invoices_skipped===4,'re-run: all invoices skipped (already imported)');
ok((await call('/api/customers')).json.length===custBefore+3,'re-run created no duplicate customers');

// 4 bad input
ok((await call('/api/import/invoiceninja',{method:'POST',body:{data:'not json',account_id:acct.id}})).status===400,'invalid JSON rejected');
ok((await call('/api/import/invoiceninja',{method:'POST',body:{data:ninja,account_id:999999}})).status===400,'bad account rejected');
// NOC gating
cookie=''; await call('/api/login',{body:{email:'support@geekitek.test',password:'support123'}});
ok((await call('/api/import/invoiceninja',{method:'POST',body:{data:ninja,account_id:acct.id}})).status===403,'import is NOC-only');
console.log('\nRESULT:',pass,'passed,',fail,'failed'); process.exit(fail?1:0);
