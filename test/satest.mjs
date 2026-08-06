const B=process.env.BASE ?? 'http://localhost:3000'; let cookie='';
async function call(path,{method='GET',body}={}){ const h={}; if(body!==undefined){h['content-type']='application/json';method=method==='GET'?'POST':method;} if(cookie)h.cookie=cookie; const r=await fetch(B+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined}); const sc=r.headers.get('set-cookie'); if(sc)cookie=sc.split(';')[0]; const t=await r.text(); let j=null;try{j=JSON.parse(t);}catch{} return {status:r.status,json:j,t}; }
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(c?'PASS':'FAIL',m);};
await call('/api/login',{body:{email:'admin@geekitek.test',password:'admin123'}});
const sid=(await call('/api/sites')).json[0].id;
// initially empty (or {}), no PUT existed before
let a=(await call('/api/sites/'+sid+'/access')).json;
ok(typeof a==='object','GET access returns object');
// save structured access + contacts + notes
let r=await call('/api/sites/'+sid+'/access',{method:'PUT',body:{gate_code:'4455#',front_door:'A12',lockbox:'9900',access_hours:'Mon-Fri 8-5',notes:'Ring bell twice',contacts:[{name:'Manager Bob',phone:'555-1212'},{name:'',phone:''}]}});
ok(r.json&&r.json.ok,'PUT access ok');
a=(await call('/api/sites/'+sid+'/access')).json;
ok(a.gate_code==='4455#'&&a.front_door==='A12'&&a.lockbox==='9900'&&a.access_hours==='Mon-Fri 8-5'&&a.notes==='Ring bell twice','fields persisted');
ok(a.contacts.length===1&&a.contacts[0].name==='Manager Bob'&&a.contacts[0].phone==='555-1212','empty contact dropped, real one kept');
// edit/add: update + add a contact
r=await call('/api/sites/'+sid+'/access',{method:'PUT',body:{gate_code:'0000',contacts:[{name:'Manager Bob',phone:'555-1212'},{name:'After hours',phone:'555-9999'}]}});
a=(await call('/api/sites/'+sid+'/access')).json;
ok(a.gate_code==='0000'&&a.contacts.length===2,'edit updates + adds contact');
ok(a.front_door===''&&a.lockbox==='','cleared fields blanked (full replace semantics)');
// NOC gating
cookie=''; await call('/api/login',{body:{email:'support@geekitek.test',password:'support123'}});
ok((await call('/api/sites/'+sid+'/access')).status===403,'GET access NOC-only (support 403)');
ok((await call('/api/sites/'+sid+'/access',{method:'PUT',body:{gate_code:'x'}})).status===403,'PUT access NOC-only (support 403)');
console.log('\nRESULT:',pass,'passed,',fail,'failed'); process.exit(fail?1:0);
