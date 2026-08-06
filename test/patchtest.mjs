const B=process.env.BASE ?? 'http://localhost:3000'; let cookie='';
async function call(path,{method='GET',body}={}){ const h={}; if(body!==undefined){h['content-type']='application/json';method=method==='GET'?'POST':method;} if(cookie)h.cookie=cookie; const r=await fetch(B+path,{method,headers:h,body:body!==undefined?JSON.stringify(body):undefined}); const sc=r.headers.get('set-cookie'); if(sc)cookie=sc.split(';')[0]; const t=await r.text(); let j=null;try{j=JSON.parse(t);}catch{} return {status:r.status,json:j,t}; }
let pass=0,fail=0; const ok=(c,m)=>{c?pass++:fail++;console.log(c?'PASS':'FAIL',m);};
await call('/api/login',{body:{email:'admin@geekitek.test',password:'admin123'}});
// find a site id and a pop id
const sites=(await call('/api/sites')).json; const sid=sites[0].id;
const pops=(await call('/api/pops')).json; const pid=pops.length?pops[0].id:null;
console.log('site',sid,'pop',pid);

// initial: patch not enabled
let d=(await call('/api/patch/site/'+sid)).json;
ok(d.enabled===false,'site patch initially disabled');
ok(Array.isArray(d.devices)&&Array.isArray(d.circuits),'context returns devices+circuits arrays');

// enable
let r=await call('/api/patch/site/'+sid+'/enable',{body:{enabled:true}});
ok(r.json.enabled===true,'enable works');
// site GET reflects patch_enabled
ok((await call('/api/sites/'+sid)).json.patch_enabled===1,'site GET shows patch_enabled=1');

// add panel
r=await call('/api/patch/site/'+sid+'/panels',{body:{name:'Rack A - Patch 1',location:'MDF',ports:24,notes:'main'}});
const panelId=r.json.id; ok(panelId>0,'panel created');
d=(await call('/api/patch/site/'+sid)).json;
ok(d.panels.length===1&&d.panels[0].ports===24,'panel listed with 24 ports');

// upsert a port with linked device (if any) + free circuit text + status used
const dev=d.devices[0]; const circ=d.circuits[0];
r=await call('/api/patch/panels/'+panelId+'/ports/3',{method:'PUT',body:{label:'Uplink',device_id:dev?dev.id:'',circuit_text:'Cox 500M',far_end:'Rack B p12',status:'used',note:'blue cable'}});
ok(r.json.ok,'port 3 upsert ok');
d=(await call('/api/patch/site/'+sid)).json; let p3=d.panels[0].used_ports.find(x=>x.port_no===3);
ok(p3&&p3.status==='used'&&p3.label==='Uplink'&&p3.circuit_text==='Cox 500M','port 3 saved fields');
ok(dev? p3.device_id===dev.id : true,'port 3 device linked'+(dev?' ('+dev.name+')':' (no devices to link)'));

// upsert port with linked circuit id if available
if(circ){ await call('/api/patch/panels/'+panelId+'/ports/5',{method:'PUT',body:{circuit_id:circ.id,status:'reserved'}}); d=(await call('/api/patch/site/'+sid)).json; let p5=d.panels[0].used_ports.find(x=>x.port_no===5); ok(p5&&p5.circuit_id===circ.id&&p5.status==='reserved','port 5 linked circuit + reserved'); } else ok(true,'no circuits to link (skipped)');

// clearing a port removes the row
await call('/api/patch/panels/'+panelId+'/ports/3',{method:'PUT',body:{status:'free'}});
d=(await call('/api/patch/site/'+sid)).json; ok(!d.panels[0].used_ports.find(x=>x.port_no===3),'clearing port removes row');

// port out of range rejected
r=await call('/api/patch/panels/'+panelId+'/ports/99',{method:'PUT',body:{status:'used'}});
ok(r.status===400,'out-of-range port rejected');

// shrink panel ports drops high-numbered rows
await call('/api/patch/panels/'+panelId+'/ports/20',{method:'PUT',body:{status:'used',label:'x'}});
await call('/api/patch/panels/'+panelId,{method:'PUT',body:{ports:12}});
d=(await call('/api/patch/site/'+sid)).json; ok(d.panels[0].ports===12 && !d.panels[0].used_ports.find(x=>x.port_no===20),'shrinking ports removes out-of-range rows');

// POP side works too
if(pid){ await call('/api/patch/pop/'+pid+'/panels',{body:{name:'POP Patch',ports:48}}); const pd=(await call('/api/patch/pop/'+pid)).json; ok(pd.enabled===true&&pd.panels.length===1&&pd.panels[0].ports===48,'POP: adding panel auto-enables + lists'); } else ok(true,'no POP to test (skipped)');

// delete panel
await call('/api/patch/panels/'+panelId,{method:'DELETE'});
d=(await call('/api/patch/site/'+sid)).json; ok(d.panels.length===0,'panel deleted');

console.log('\nRESULT:',pass,'passed,',fail,'failed'); process.exit(fail?1:0);
