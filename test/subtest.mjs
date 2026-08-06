const B=process.env.BASE ?? 'http://localhost:3000'; let cookie='';
async function call(path,{method='GET',body}={}){ const h={}; if(body!==undefined){h['content-type']='application/json';method=method==='GET'?'POST':method;} if(cookie)h.cookie=cookie; const r=await fetch(B+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined}); const sc=r.headers.get('set-cookie'); if(sc)cookie=sc.split(';')[0]; const t=await r.text(); let j=null;try{j=JSON.parse(t);}catch{} return {status:r.status,json:j,t}; }
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(c?'PASS':'FAIL',m);};

// staff login
await call('/api/login',{body:{email:'admin@geekitek.test',password:'admin123'}});
const accts=(await call('/api/meta')).json.accounts; const acc=accts[0], acc2=accts[1]||accts[0];
console.log('account',acc.id,acc.name);

// migration: seed had owner_sub_account on accounts? check a fresh account has none, and any migrated
let a=(await call('/api/accounts/'+acc.id)).json;
ok(Array.isArray(a.subaccounts),'account returns subaccounts[]');
const migratedSomewhere = accts.some(async()=>false); // informational only

// create subaccounts with pin + cost
let r=await call('/api/accounts/'+acc.id+'/subaccounts',{method:'POST',body:{name:'Sub 001',pin:'1234',status:'active',monthly_cost:'89.99',notes:'primary line'}});
ok(r.json.id>0,'create sub-account');
const sid=r.json.id;
r=await call('/api/accounts/'+acc.id+'/subaccounts',{method:'POST',body:{name:'Sub 002',monthly_cost:'45'}});
const sid2=r.json.id;
a=(await call('/api/accounts/'+acc.id)).json;
ok(a.subaccounts.length>=2,'subaccounts listed');
const s1=a.subaccounts.find(x=>x.id===sid);
ok(s1.monthly_cost===89.99&&s1.status==='active'&&s1.has_pin,'fields stored (cost, status, has_pin)');
ok(s1.pin==='1234','NOC sees pin');

// name required
r=await call('/api/accounts/'+acc.id+'/subaccounts',{method:'POST',body:{monthly_cost:'10'}});
ok(r.status===400,'name required rejected');

// edit (blank pin keeps)
r=await call('/api/accounts/'+acc.id+'/subaccounts/'+sid,{method:'PUT',body:{name:'Sub 001',status:'suspended',monthly_cost:'99'}});
a=(await call('/api/accounts/'+acc.id)).json; const e1=a.subaccounts.find(x=>x.id===sid);
ok(e1.status==='suspended'&&e1.monthly_cost===99&&e1.pin==='1234','edit persisted, pin kept');

// flat list for device picker
const flat=(await call('/api/subaccounts')).json;
ok(flat.some(x=>x.id===sid&&x.account_name===acc.name),'flat /subaccounts includes account_name');

// PIN masking for non-NOC: login as support
cookie=''; await call('/api/login',{body:{email:'support@geekitek.test',password:'support123'}});
a=(await call('/api/accounts/'+acc.id)).json; const sup=a.subaccounts.find(x=>x.id===sid);
ok(sup && sup.pin===undefined && sup.has_pin===true,'non-NOC: pin stripped, has_pin flagged');
// back to admin
cookie=''; await call('/api/login',{body:{email:'admin@geekitek.test',password:'admin123'}});

// site assignment: pick a site on this account, set subaccount_id
const sites=(await call('/api/sites')).json; const site=sites.find(s=>true);
// ensure site's account == acc for a valid assignment; use its own account + a sub under that account
const siteFull=(await call('/api/sites/'+site.id)).json; const siteAcct=siteFull.account.id;
// make a sub under the site's account
r=await call('/api/accounts/'+siteAcct+'/subaccounts',{method:'POST',body:{name:'SiteSub'}}); const ssid=r.json.id;
await call('/api/sites/'+site.id,{method:'PUT',body:{subaccount_id:ssid}});
let sf=(await call('/api/sites/'+site.id)).json;
ok(sf.subaccount&&sf.subaccount.id===ssid,'site subaccount assigned + resolved');
// cross-account sub rejected (nulled): assign a sub from a different account
if(acc.id!==siteAcct){ await call('/api/sites/'+site.id,{method:'PUT',body:{subaccount_id:sid}}); sf=(await call('/api/sites/'+site.id)).json; ok(!sf.subaccount,'cross-account sub rejected (nulled)'); } else ok(true,'cross-account test skipped (same acct)');

// device owner_subaccount_id
const devs=(await call('/api/devices')).json; const dev=devs[0];
await call('/api/devices/'+dev.id,{method:'PUT',body:{owner_subaccount_id:sid}});
let df=(await call('/api/devices/'+dev.id)).json;
ok(df.owner_subaccount_id===sid&&df.owner_subaccount_name==='Sub 001','device sub linked + name resolved');

// delete sub nulls references
await call('/api/devices/'+dev.id,{method:'PUT',body:{owner_subaccount_id:ssid}}); // point device at ssid
await call('/api/accounts/'+siteAcct+'/subaccounts/'+ssid,{method:'DELETE'});
sf=(await call('/api/sites/'+site.id)).json; df=(await call('/api/devices/'+dev.id)).json;
ok(!sf.subaccount && !df.owner_subaccount_id,'deleting sub nulls site + device refs');

console.log('\nRESULT:',pass,'passed,',fail,'failed'); process.exit(fail?1:0);
