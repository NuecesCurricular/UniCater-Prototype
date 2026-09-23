(function (root) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const qty = value => Math.round(Number(value) * 1000) / 1000;
  const money = (quantity, price) => Number((BigInt(Math.round(quantity * 1000)) * BigInt(Math.round(price * 1000)) + 5000n) / 10000n);
  function requireThat(ok, message) { if (!ok) throw new Error(message); }
  function positive(value, allowZero = false) { const n = Number(value); requireThat(Number.isFinite(n) && (allowZero ? n >= 0 : n > 0), '请输入有效数量'); return qty(n); }
  function seed() {
    const now = Date.now();
    const products = [
      ['potato', '土豆', '蔬菜', '鲜品、未去皮、中号', 'kg', 30, 3, 0],
      ['cabbage', '大白菜', '蔬菜', '鲜品、完整净菜', 'kg', 12, 2.2, 1],
      ['tomato', '西红柿', '蔬菜', '鲜品、中号', 'kg', 0, 4.6, 2],
      ['pork', '猪里脊', '肉类', '冷鲜、去筋膜', 'kg', 0, 32, 3],
      ['apple', '红富士苹果', '水果', '80–85mm', 'kg', 0, 6.4, 4],
      ['oil', '大豆油', '粮油', '20L/桶', '桶', 4, 168, 5]
    ].map(([id, name, category, spec, unit, stock, price, sprite], index) => ({id, name, category, spec, unit, sprite, code: `UC-${String(index + 1).padStart(4, '0')}`, stock, value: money(stock, price), locked: 0, historyPrice: price, enabled: true}));
    const suppliers = [{id:'s1',name:'泉城鲜蔬配送中心',minimum:0}, {id:'s2',name:'绿源生鲜商贸',minimum:200}];
    const offers = suppliers.flatMap((s, si) => products.map((p, i) => ({id:`${s.id}-${p.id}`,supplier:s.id,product:p.id,sku:`${s.id.toUpperCase()}-${i + 101}`,name:si && p.id==='potato'?'马铃薯中号':p.name,spec:p.spec,unit:p.unit,factor:1,price:qty(p.historyPrice*(si?1.05:1)),supply:true,matched:true,approved:true,own:false})));
    return {schema:1,seq:30,revision:0,products,suppliers,offers,plans:[],rfqs:[{id:'RFQ-001',name:'本期常用食材报价',products:products.map(p=>p.id),start:now-86400000*2,end:now-3600000,validFrom:now-1800000,validTo:now+86400000*14,status:'已接受报价',responses:suppliers.map(s=>({supplier:s.id,lines:clone(offers.filter(o=>o.supplier===s.id)),at:now-7200000})),accepted:offers.map(o=>o.id),gaps:[]}],demands:[],orders:[],issues:[],movements:[],manual:[],exceptions:[],bills:[],notes:[],settings:{period:'半月',inspection:'sampling',sampleRate:34,requireWeight:true,requirePhoto:false,pickupHours:4},priceSheets:[{id:'PS-001',name:'学校基础价格',updated:now,lines:clone(offers.filter(o=>o.supplier==='s1'))}],audit:[]};
  }
  function id(db, prefix) { db.seq++; return `${prefix}-${String(db.seq).padStart(5,'0')}`; }
  function product(db, pid) { const p=db.products.find(x=>x.id===pid); requireThat(p,'商品不存在'); return p; }
  function reserved(db, pid) { return qty(db.issues.filter(x=>x.status==='待领取').flatMap(x=>x.lines).filter(x=>x.product===pid).reduce((s,x)=>s+x.quantity,0)); }
  function available(db, pid) { const p=product(db,pid); return Math.max(0,qty(p.stock-p.locked-reserved(db,pid))); }
  function prices(db,pid,now=Date.now()){
    const bySupplier=new Map();
    db.rfqs.filter(r=>r.status==='已接受报价'&&r.products.includes(pid)&&r.validFrom<=now&&now<r.validTo)
      .sort((a,b)=>a.validFrom-b.validFrom).forEach(r=>r.responses.forEach(response=>{
        bySupplier.delete(response.supplier);
        const candidates=response.lines.filter(l=>{const live=db.offers.find(o=>o.id===l.id);return l.product===pid&&l.supply&&l.approved&&r.accepted.includes(l.id)&&live?.approved&&live.spec===l.spec&&live.factor===l.factor;})
          .map(l=>({...l,price:qty(l.price/l.factor),rfq:r.id})).sort((a,b)=>a.price-b.price);
        if(candidates.length)bySupplier.set(response.supplier,candidates[0]);
      }));
    return [...bySupplier.values()].sort((a,b)=>a.price-b.price);
  }
  function referencePrice(db,pid){
    const rs=db.rfqs.filter(r=>r.status==='已接受报价'&&r.validFrom<=Date.now()&&r.products.includes(pid)).sort((a,b)=>b.validFrom-a.validFrom);
    for(const r of rs){const ls=r.responses.flatMap(x=>x.lines).filter(l=>l.product===pid&&l.supply&&l.approved&&r.accepted.includes(l.id));if(ls.length)return Math.min(...ls.map(l=>qty(l.price/l.factor)));}
    return product(db,pid).historyPrice;
  }
  function move(db, data) {
    const m={id:id(db,'MOV'),at:Date.now(),sealed:false,...data}; db.movements.push(m); return m;
  }
  function addStock(db,pid,n,value) { const p=product(db,pid); p.stock=qty(p.stock+n); p.value+=value; requireThat(p.stock>=0&&p.value>=0,'库存数量或金额不足，需核对关联流水'); if(!p.stock)p.value=0; }
  function takeStock(db,pid,n) { if(!n)return 0; const p=product(db,pid); requireThat(n<=p.stock-p.locked+0.0001,'库存不足或存在锁定'); const value=n===p.stock?p.value:Math.round(p.value*n/p.stock); addStock(db,pid,-n,-value); return value; }
  function issue(db,demand,lines,source) { const r={id:id(db,'IS'),demand,source,stall:db.demands.find(d=>d.id===demand)?.stall||'学校部门',lines,status:'待领取',due:Date.now()+db.settings.pickupHours*3600000}; db.issues.push(r); return r; }
  function order(db,lines,source,actor) { const o={id:id(db,'PO'),source,initiator:actor,status:'未提交',reason:'',lines:lines.map(l=>({...l,quantity:qty(l.need+l.extra)})),children:[],approvals:[]}; db.orders.push(o);return o; }
  function progress(db,d) {
    if(d.status!=='已审核')return {simple:d.status==='待学校审核'?'正在审核':d.status,detail:d.status};
    const related=db.issues.filter(i=>i.demand===d.id), children=db.orders.flatMap(o=>o.children).filter(c=>c.lines.some(l=>l.demand===d.id));
    const pending=db.orders.some(o=>!['已发送','已撤回','已取消'].includes(o.status)&&o.lines.some(l=>l.demand===d.id));
    if(related.some(i=>i.status==='待领取'))return {simple:'可以领取',detail:`${related.filter(i=>i.status==='待领取').length} 张领料单待领取${children.some(c=>c.status!=='已完成')?'，部分仍等到货':''}`};
    if(pending)return {simple:'正在安排',detail:'采购管理员核对需求缺口与额外备货'};
    if(children.some(c=>['待确认','已确认','取消协商中'].includes(c.status)))return {simple:'等送货',detail:children.map(c=>`${c.id} ${c.status}`).join('；')};
    if(d.unresolved?.length)return {simple:'需要处理',detail:'缺少有效报价或供货条件，采购管理员待处理'};
    const actual=related.flatMap(i=>i.actual||[]), delivered=db.movements.filter(m=>m.demand===d.id&&m.direction==='out'&&['领料出库','直接交接'].includes(m.type));
    const complete=d.lines.every(l=>delivered.filter(m=>m.product===l.product).reduce((s,m)=>s+m.quantity,0)>=l.quantity-0.0001);
    return {simple:complete?'已完成':'已结束，有差异',detail:complete?'全部已确认交接':'查看实际交接、拒绝和差额处理记录'};
  }
  function billLines(db,kind,party,start,end) {return db.movements.filter(m=>m.at>=start&&m.at<end&&!m.sealed&&((kind==='supplier'&&m.supplier===party&&m.payable!==0)||(kind==='stall'&&m.stall===party&&m.cost!==0)));}
  function period(db, at=Date.now()) {
    const d=new Date(at), current=db.settings.nextPeriod&&at>=db.settings.nextPeriodAt?db.settings.nextPeriod:db.settings.period, half=current==='半月';
    return {start:+new Date(d.getFullYear(),d.getMonth(),half&&d.getDate()>15?16:1),end:+new Date(d.getFullYear(),half&&d.getDate()<=15?d.getMonth():d.getMonth()+1,half&&d.getDate()<=15?16:1)};
  }
  function sampleTasks(db,c) {
    if(c.samples)return c.samples;
    const eligible=c.lines.map((l,i)=>product(db,l.product).unit==='kg'?i:-1).filter(i=>i>=0);
    return db.settings.inspection==='full'?eligible:eligible.slice(0,Math.ceil(eligible.length*db.settings.sampleRate/100));
  }
  function refreshOpenBills(db,posted) {
    for(const b of db.bills.filter(b=>b.status!=='已结算')) {
      if(posted.at<b.start||posted.at>=b.end)continue;
      if(!(b.kind==='supplier'?posted.supplier===b.party&&posted.payable:posted.stall===b.party&&posted.cost))continue;
      if(b.lines.some(l=>l.id===posted.id))continue;
      b.lines.push(clone(posted));b.amount+=b.kind==='supplier'?posted.payable:posted.cost;
      b.school=false;b.other=false;b.changed=true;
    }
  }
  // Commands always run on a fresh copy; a rejected transition cannot partially alter stock.
  function execute(input, action, args={}, actor={name:'王璐',role:'school'}) {
    const db=clone(input), now=Date.now();if(db.settings.nextPeriod&&now>=db.settings.nextPeriodAt){db.settings.period=db.settings.nextPeriod;delete db.settings.nextPeriod;delete db.settings.nextPeriodAt;} const school=()=>requireThat(actor.role==='school','仅学校授权人员可操作');
    const get=(key,value)=>{const x=db[key].find(r=>r.id===value);requireThat(x,'单据不存在');return x;};
    switch(action){
      case 'catalog-request': {requireThat(['school','catering'].includes(actor.role),'无申请权限');requireThat(args.name?.trim()&&args.spec?.trim(),'名称及必要规格必填');db.requests=db.requests||[];db.requests.push({id:id(db,'CAT'),...args,status:'待确认',initiator:actor.name});break;}
      case 'catalog-approve': {school();const r=get('requests',args.id);requireThat(r.status==='待确认','已处理');const pid=id(db,'ITEM');db.products.push({id:pid,name:r.name,category:r.category||'其他',spec:r.spec,unit:r.unit||'kg',code:pid,sprite:0,stock:0,value:0,locked:0,historyPrice:null,enabled:true});r.status='已纳入';r.product=pid;break;}
      case 'demand-delete': {const d=get('demands',args.id);requireThat(d.initiator===actor.name&&d.status.includes('审核'),'仅本人未转换需求可删除');db.demands=db.demands.filter(x=>x.id!==d.id);break;}
      case 'demand-update': {const d=get('demands',args.id);requireThat(d.initiator===actor.name&&d.status.includes('审核'),'仅本人未转换需求可修改');d.lines=args.lines.filter(l=>Number(l.quantity)>0).map(l=>({product:l.product,quantity:positive(l.quantity),supplier:l.supplier||''}));requireThat(d.lines.length,'至少选择一个商品');d.due=args.due;d.status=actor.role==='school'?'待学校审核':'待餐饮公司审核';break;}
      case 'review-batch': {requireThat(['school','catering'].includes(actor.role),'无审核权限');requireThat(args.demands?.length,'没有当前可审核需求');const oldIds=db.orders.map(o=>o.id);for(const d of args.demands)Object.assign(db,execute(db,'demand-review',d,actor));const fresh=db.orders.filter(o=>!oldIds.includes(o.id));if(fresh.length>1){const head=fresh[0];head.lines=fresh.flatMap(o=>o.lines);head.source='汇总审核';db.orders=db.orders.filter(o=>oldIds.includes(o.id)||o.id===head.id);}break;}

      case 'demand-gap': {school();const d=get('demands',args.id);requireThat(d.status==='已审核'&&d.unresolved?.length,'无待处理缺口');if(args.close){requireThat(args.reason?.trim(),'关闭缺口必须说明原因');d.closedGaps=clone(d.unresolved);d.gapReason=args.reason;d.unresolved=[];break;}const buy=[],remaining=[];for(const l of d.unresolved){const pr=prices(db,l.product)[0];if(pr)buy.push({product:l.product,demand:d.id,stall:d.stall,need:l.quantity,extra:0,supplier:pr.supplier,price:pr.price});else remaining.push(l);}requireThat(buy.length,'仍没有有效报价，请先处理报价或明确关闭缺口');order(db,buy,d.id,actor.name);d.unresolved=remaining;break;}
      case 'receipt-start': {school();const c=db.orders.flatMap(o=>o.children).find(c=>c.id===args.id);requireThat(c?.status==='已确认','该子订单不可验收');c.samples=sampleTasks(db,c);c.inspection=c.inspection||db.settings.inspection;break;}
      case 'order-create': {school();const lines=args.lines.filter(l=>Number(l.quantity)>0).map(l=>{const pr=prices(db,l.product).find(p=>p.supplier===(l.supplier||'s1'));requireThat(pr,'学校备货需先落实有效报价');return {product:l.product,need:0,extra:positive(l.quantity),supplier:pr.supplier,price:pr.price,stall:'学校备货',demand:''};});requireThat(lines.length,'请选择至少一个备货商品');order(db,lines,'学校自主备货',actor.name);break;}
      case 'plan-create': school(); db.plans.push({id:id(db,'PLAN'),name:args.name||'新周期采购清单',status:'供应商报送',products:db.products.map(p=>p.id),forecasts:[],reported:[],created:now});break;
      case 'plan-step': {const p=get('plans',args.id);const steps=['供应商报送','学校初筛','档口填报','餐饮公司审核','学校审核','已固定']; const required=['supplier','school','catering','catering','school'];requireThat(actor.role===required[steps.indexOf(p.status)],'当前阶段需由对应参与方处理'); if(p.status==='档口填报')p.forecasts=args.lines.filter(l=>positive(l.quantity,true)>0);if(p.status==='学校初筛'){p.products=args.products;requireThat(p.products.length,'至少保留一个采购项');}p.status=steps[steps.indexOf(p.status)+1];break;}
      case 'match': {const o=get('offers',args.id);if(args.confirm){school();requireThat(o.matched,'先提交对应建议');requireThat(o.spec===product(db,o.product).spec,'关键规格不一致，先补充准确规格；不按同名强行合并库存');o.approved=true;}else{requireThat(['supplier','school'].includes(actor.role),'无对应权限');o.spec=args.spec||o.spec;o.factor=positive(args.factor||1);o.matched=true;o.approved=false;}break;}
      case 'offer-create':requireThat(actor.role==='supplier','仅供应商可维护'); db.offers.push({id:id(db,'SKU'),supplier:'s1',product:args.product,sku:args.sku||id(db,'OWN'),name:args.name,spec:args.spec,unit:args.unit||product(db,args.product).unit,factor:positive(args.factor||1),price:positive(args.price,true),supply:true,matched:false,approved:false,own:true});break;
      case 'price-save':{requireThat(actor.role==='supplier','仅供应商可维护');let ps=args.id?get('priceSheets',args.id):{id:id(db,'PS')};requireThat(args.name?.trim(),'填写价格单名称');ps.name=args.name;if(args.validFrom||args.validTo){requireThat(args.validFrom<args.validTo,'检查内部价格有效区间');ps.validFrom=args.validFrom;ps.validTo=args.validTo;}ps.lines=args.lines.map(l=>({...get('offers',l.id),price:positive(l.price,true),supply:l.supply}));ps.updated=now;if(!args.id)db.priceSheets.push(ps);break;}
      case 'rfq-create':school();{const plan=get('plans',args.plan);requireThat(plan.status==='已固定','先固定采购清单');requireThat(args.start<args.end&&args.validFrom>=args.end&&args.validTo>args.validFrom,'检查报价时间与生效区间');db.rfqs.push({id:id(db,'RFQ'),name:args.name,plan:plan.id,products:clone(plan.products),start:args.start,end:args.end,validFrom:args.validFrom,validTo:args.validTo,status:'待报价',responses:[],accepted:[],gaps:[]});}break;
      case 'rfq-submit': {requireThat(actor.role==='supplier','仅供应商提交');const r=get('rfqs',args.id);requireThat(now>=r.start&&now<r.end,'不在报价提交时间内');const ps=get('priceSheets',args.sheet);r.responses=r.responses.filter(x=>x.supplier!=='s1');r.responses.push({supplier:'s1',lines:clone(ps.lines.filter(l=>r.products.includes(l.product))),at:now});break;}
      case 'rfq-withdraw': {requireThat(actor.role==='supplier','仅供应商操作');const r=get('rfqs',args.id);requireThat(now<r.end,'报价已截止');r.responses=r.responses.filter(x=>x.supplier!=='s1');break;}
      case 'rfq-accept': {school();const r=get('rfqs',args.id);requireThat(now>=r.end&&r.status!=='已接受报价','报价截止后确认一次；后续调整请新建补充邀约');const lines=r.responses.flatMap(x=>x.lines);const accepted=args.accepted.filter(id=>lines.some(l=>l.id===id&&l.approved&&l.supply));const gaps=r.products.filter(pid=>!lines.some(l=>l.product===pid&&accepted.includes(l.id)));requireThat(!gaps.length||args.gapReason?.trim(),'未覆盖商品需填写补充询价或终止原因');r.accepted=accepted;r.gaps=gaps;r.gapReason=args.gapReason;r.status='已接受报价';break;}
      case 'demand-create': {requireThat(['school','catering'].includes(actor.role),'无采购需求权限');const lines=args.lines.filter(l=>Number(l.quantity)>0).map(l=>({product:l.product,quantity:positive(l.quantity),supplier:l.supplier||''}));requireThat(lines.length,'至少选择一个商品');db.demands.push({id:id(db,'DEM'),stall:args.stall||'101号窗口',initiator:actor.name,due:args.due,status:actor.role==='school'?'待学校审核':'待餐饮公司审核',lines,created:now});break;}
      case 'demand-review': {const d=get('demands',args.id);requireThat((d.status==='待餐饮公司审核'&&actor.role==='catering')||(d.status==='待学校审核'&&actor.role==='school'),'无当前节点审核权限');if(d.status==='待餐饮公司审核'){d.rejectedByCompany=[];for(const l of d.lines){const decision=args.lines.find(x=>x.product===l.product);if(decision?.reject){requireThat(decision.reason?.trim(),'拒绝商品必须填写原因');d.rejectedByCompany.push({...l,reason:decision.reason});}}d.status=d.rejectedByCompany.length===d.lines.length?'已审核':'待学校审核';d.rejected=clone(d.rejectedByCompany);break;}school();d.status='已审核';d.unresolved=[];d.rejected=clone(d.rejectedByCompany||[]);const stock=[],buy=[];for(const l of d.lines){if(d.rejected.some(x=>x.product===l.product))continue;const choice=args.lines.find(x=>x.product===l.product)||{};if(choice.reject){requireThat(choice.reason?.trim(),'拒绝商品必须填写原因');d.rejected.push({...l,reason:choice.reason});continue;}const n=Math.min(l.quantity,available(db,l.product));if(n)stock.push({product:l.product,quantity:n});const missing=qty(l.quantity-n);const ps=prices(db,l.product),p=ps.find(p=>p.supplier===l.supplier)||ps[0];if(missing&&p)buy.push({product:l.product,demand:d.id,stall:d.stall,need:missing,extra:0,supplier:p.supplier,price:p.price});else if(missing)d.unresolved.push({product:l.product,quantity:missing});}if(stock.length)issue(db,d.id,stock,d.id);if(buy.length)order(db,buy,d.id,actor.name);break;}
      case 'order-extra': {school();const o=get('orders',args.id);requireThat(o.status==='未提交','只能调整未提交订单');o.lines.forEach((l,i)=>{l.extra=positive(args.extra[i]||0,true);l.quantity=qty(l.need+l.extra);if(args.suppliers?.[i])l.supplier=args.suppliers[i];});break;}
      case 'order-submit': {school();const o=get('orders',args.id);requireThat(o.status==='未提交','单据已提交');for(const l of o.lines){const p=prices(db,l.product).find(x=>x.supplier===l.supplier);requireThat(p,'没有当前有效报价，不能使用历史参考价下单');l.price=p.price;l.offer=p.id;l.sku=p.sku;l.unit=product(db,l.product).unit;l.spec=product(db,l.product).spec;}for(const s of db.suppliers){const total=o.lines.filter(l=>l.supplier===s.id).reduce((sum,l)=>sum+money(l.quantity,l.price),0);requireThat(!total||total>=s.minimum*100,`${s.name}未达到起送金额 ¥${s.minimum}，请调整备货或协商供货`);}o.status='待审核';o.submitted=now;o.approvals=[{name:actor.name,result:'已提交',at:now},{name:'刘志刚',result:'待审批'}];break;}
      case 'order-approve': {school();const o=get('orders',args.id);requireThat(o.status==='待审核','订单不在待审核状态');o.status='已发送';o.approvals[1]={name:'刘志刚',result:'已通过',at:now};o.children=db.suppliers.filter(s=>o.lines.some(l=>l.supplier===s.id)).map((s,i)=>({id:`${o.id}-${i+1}`,supplier:s.id,status:'待确认',lines:clone(o.lines.filter(l=>l.supplier===s.id))}));break;}
      case 'order-withdraw': {school();const o=get('orders',args.id);requireThat(o.initiator===actor.name,'仅发起人可撤回');requireThat(!o.children.some(c=>c.status!=='待确认')&&['待审核','已发送'].includes(o.status),'供应商已确认或订单不允许撤回，请协商取消');requireThat(args.reason?.trim(),'请填写撤回原因');o.status='已撤回';o.reason=args.reason;o.children.forEach(c=>c.status='已撤回');db.notes.push({id:id(db,'MSG'),text:`${o.id} 已撤回：${args.reason}；知会全部审批人和已收到订单的供应商`});break;}
      case 'order-resubmit': {school();const old=get('orders',args.id);requireThat(old.status==='已撤回','不是已撤回订单');requireThat(!db.orders.some(x=>x.source===old.id),'已创建重提单');order(db,clone(old.lines),old.id,actor.name);break;}
      case 'child-confirm': {requireThat(actor.role==='supplier','仅供应商确认');const c=db.orders.flatMap(o=>o.children).find(c=>c.id===args.id);requireThat(c?.status==='待确认'&&c.supplier===(actor.supplier||'s1'),'仅可确认本供应商待确认订单');c.status='已确认';break;}
      case 'cancel-request': {school();const c=db.orders.flatMap(o=>o.children).find(c=>c.id===args.id);requireThat(c&&['待确认','已确认'].includes(c.status),'已验收或已关闭，请新建异常处理单');requireThat(args.reason?.trim(),'填写协商原因');c.beforeCancel=c.status;c.status='取消协商中';c.reason=args.reason;break;}
      case 'cancel-reply': {requireThat(actor.role==='supplier','仅供应商确认协商');const c=db.orders.flatMap(o=>o.children).find(c=>c.id===args.id);requireThat(c?.status==='取消协商中'&&c.supplier===(actor.supplier||'s1'),'无待处理协商');c.status=args.agree?'已取消':c.beforeCancel;break;}
      case 'receipt': {school();const c=db.orders.flatMap(o=>o.children).find(c=>c.id===args.id);requireThat(c?.status==='已确认','该子订单不能重复入库');requireThat(args.signSchool&&args.signSupplier,'完成学校与本供应商确认');if(args.direct)requireThat(args.signStall,'直接出库须确认实际交接');const actual=[];for(const [i,l] of c.lines.entries()){const n=positive(args.quantities[i],true);requireThat(n===l.quantity||args.reason?.trim(),'差异必须说明原因');const value=money(n,l.price);const m=move(db,{type:'采购入库',source:c.id,product:l.product,supplier:c.supplier,quantity:n,direction:'in',value,payable:value,cost:0,price:l.price,photos:args.photos||[],reason:args.reason||''});let assigned=Math.min(l.need,n);if(args.allocations?.[i]!==undefined){assigned=positive(args.allocations[i],true);requireThat(assigned<=n,'档口分配不能超过实际入库');}if(args.direct&&assigned){const cost=money(assigned,l.price);move(db,{type:'直接交接',source:m.id,demand:l.demand,stall:l.stall,product:l.product,quantity:assigned,direction:'out',value:cost,payable:0,cost,supplier:'',price:l.price});addStock(db,l.product,qty(n-assigned),value-cost);}else {addStock(db,l.product,n,value);if(assigned)issue(db,l.demand,[{product:l.product,quantity:assigned}],m.id);}actual.push(n);}c.status='已完成';c.evidence=clone(args.evidence||{});c.signatures={school:actor.name,supplier:args.signSupplier,stall:args.signStall||false};c.fallback=args.fallback||'';c.actual=actual;c.difference=actual.some((n,i)=>n!==c.lines[i].quantity);break;}
      case 'issue-complete': {school();const r=get('issues',args.id);requireThat(r.status==='待领取','不能重复出库');requireThat(args.recipient?.trim(),'请填写实际领料人');r.actual=[];for(const [i,l]of r.lines.entries()){const n=positive(args.quantities[i],true);requireThat(n<=l.quantity,'超领须重新分配');requireThat(n===l.quantity||args.reason?.trim(),'差异出库须填写原因');const value=takeStock(db,l.product,n);move(db,{type:'领料出库',source:r.id,demand:r.demand,stall:r.stall,product:l.product,quantity:n,direction:'out',value,cost:value,payable:0,supplier:'',recipient:args.recipient});r.actual.push({product:l.product,quantity:n});}r.evidence=clone(args.evidence||{});r.reason=args.reason||'';r.status='已完成';r.completed=now;break;}
      case 'issue-handle': {school();const r=get('issues',args.id);requireThat(r.status==='待领取','当前单据不可处理');requireThat(args.reason?.trim(),'填写处理原因');if(args.mode==='delay'){requireThat(args.due>now,'新领料时间应在未来');r.due=args.due;}else r.status='已取消';r.reason=args.reason;db.notes.push({id:id(db,'MSG'),text:`${r.id} ${args.mode==='delay'?'延期':'取消预留'}：${args.reason}`});break;}
      case 'stock-lock': {school();const p=product(db,args.product);const n=positive(args.quantity);requireThat(args.reason?.trim(),'填写锁定或解锁原因');if(args.unlock){requireThat(n<=p.locked,'超过锁定数量');p.locked=qty(p.locked-n);}else{requireThat(n<=available(db,p.id),'不能直接锁定已占用数量，请先处理原领料单');p.locked=qty(p.locked+n);}break;}
      case 'manual-create': {school();const allowed=['期初入库','其他入库','直接出库','消耗抽检','报损销毁'];requireThat(allowed.includes(args.type),'采购、退货和更正须关联专门来源');requireThat(args.reason?.trim()&&args.recipient?.trim(),'事由与交接/责任对象必填');const n=positive(args.quantity);let price=positive(args.price||0,true);if(args.type.includes('入库'))requireThat(price>0||args.zeroReason?.trim(),'零价值入库须说明无偿依据');db.manual.push({id:id(db,'DOC'),type:args.type,product:args.product,quantity:n,price,reason:args.reason,recipient:args.recipient,zeroReason:args.zeroReason,status:'待执行'});break;}
      case 'manual-complete': {school();const r=get('manual',args.id);requireThat(r.status==='待执行','已执行，不能重复');const incoming=r.type.includes('入库');const n=positive(args.quantity??r.quantity);requireThat(n===r.quantity||args.reason?.trim(),'差异执行须填原因');let value;if(incoming){value=money(n,r.price);addStock(db,r.product,n,value);}else{requireThat(n<=available(db,r.product),'不能占用别的领料单或锁定库存');value=takeStock(db,r.product,n);}move(db,{type:r.type,source:r.id,product:r.product,quantity:n,direction:incoming?'in':'out',value,payable:0,cost:r.type==='直接出库'?value:0,stall:r.type==='直接出库'?r.recipient:'',supplier:'',reason:r.reason});r.status='已完成';break;}
      case 'exception-create': {
        requireThat(['school','catering','supplier'].includes(actor.role),'无异常登记权限');
        const m=get('movements',args.source),financial=args.type==='金额协商调整';
        requireThat(actor.role==='school'||(actor.role==='supplier'?m.supplier===(actor.supplier||'s1'):!!m.stall),'无权处理其他主体来源');
        const n=financial?0:positive(args.quantity),amount=financial?Math.round(Number(args.amount)*100):0;
        requireThat(args.reason?.trim(),'请填写新单原因');
        requireThat(['供应商退货','档口退回','录入更正','金额协商调整'].includes(args.type),'处理类型无效');
        if(financial)requireThat(Number.isFinite(amount)&&amount!==0,'填写非零金额差额，减少应结填负数');
        if(args.type==='供应商退货')requireThat(m.type==='采购入库','请选择原采购入库');
        if(args.type==='档口退回')requireThat(m.direction==='out'&&m.stall,'请选择原交接出库');
        if(!financial){const already=db.exceptions.filter(e=>e.source===m.id&&e.status!=='已驳回').reduce((s,e)=>s+e.quantity,0);requireThat(n+already<=m.quantity+0.0001,'超过来源尚可处理量');}
        db.exceptions.push({id:id(db,'NEW'),source:m.id,type:args.type,quantity:n,amount,reason:args.reason,status:'待核对',afterSettlement:m.sealed,created:now});break;
      }
      case 'exception-approve': {school();const e=get('exceptions',args.id);requireThat(e.status==='待核对','处理单状态已变化');requireThat(args.counterparty,'需要相关业务方确认');e.status='待执行';e.confirmed=true;break;}
      case 'exception-reject': {school();const e=get('exceptions',args.id);requireThat(['待核对','待执行'].includes(e.status),'已执行不能驳回');requireThat(args.reason?.trim(),'填写驳回原因');e.status='已驳回';e.rejection=args.reason;break;}
      case 'exception-complete': {
        school();const e=get('exceptions',args.id),m=get('movements',e.source);
        requireThat(e.status==='待执行','先完成新处理单核对');
        const n=e.quantity,value=n?Math.round(m.value*n/m.quantity):0;
        let direction,payable=0,cost=0,stockValue=value;
        if(e.type==='金额协商调整'){direction='none';payable=m.supplier?e.amount:0;cost=m.stall?e.amount:0;}
        else if(e.type==='档口退回'){addStock(db,m.product,n,value);direction='in';cost=-value;}
        else {
          requireThat(m.type==='采购入库','本版自动数量冲销处理采购入库多录；少录、错商品或关联出库错误须核对后建立正确新单');
          requireThat(n<=available(db,m.product),'实物不足、已交接或已占用，禁止直接全量冲销');
          stockValue=takeStock(db,m.product,n);direction='out';payable=-Math.round(m.payable*n/m.quantity);
        }
        const posted=move(db,{type:e.type==='录入更正'?'差额冲销':e.type,source:e.id,original:m.id,product:m.product,quantity:n,direction,value:stockValue,payable,cost,stall:m.stall||'',supplier:m.supplier||'',variance:payable?stockValue+payable:0,reason:e.reason});
        e.status='已完成';e.movement=posted.id;break;
      }
      case 'bill-create': {school();requireThat(['supplier','stall'].includes(args.kind),'选择对账类型');requireThat(args.kind==='supplier'?db.suppliers.some(s=>s.id===args.party):!db.suppliers.some(s=>s.id===args.party),'对账类型与对象不一致');requireThat(args.start<args.end,'检查结算周期');const lines=billLines(db,args.kind,args.party,args.start,args.end);requireThat(lines.length,'此周期无未结算记录');requireThat(!db.bills.some(b=>b.status!=='已结算'&&b.lines.some(l=>lines.some(m=>m.id===l.id))),'这些流水已进入待对账账单');db.bills.push({id:id(db,'BILL'),kind:args.kind,party:args.party,start:args.start,end:args.end,lines:clone(lines),status:'对账中',school:false,other:false,dispute:'',amount:lines.reduce((s,m)=>s+(args.kind==='supplier'?m.payable:m.cost),0)});break;}
      case 'bill-dispute':{const b=get('bills',args.id);requireThat(b.status!=='已结算','已结账只能创建新处理单');requireThat(args.reason?.trim(),'填写异议');b.dispute=args.reason;b.status='有异议';b.school=false;b.other=false;break;}
      case 'bill-resolve':{school();const b=get('bills',args.id);requireThat(b.status==='有异议'&&args.reason?.trim(),'填写处理说明');b.resolution=args.reason;b.status='对账中';b.dispute='';break;}
      case 'bill-confirm': {const b=get('bills',args.id);requireThat(b.status==='对账中','存在异议或已结算');if(actor.role==='school')b.school=true;else{requireThat(actor.role===(b.kind==='supplier'?'supplier':'catering')&&(b.kind!=='supplier'||b.party===(actor.supplier||'s1')),'对账主体不匹配');b.other=true;}break;}
      case 'bill-seal': {school();const b=get('bills',args.id);requireThat(b.status==='对账中'&&b.school&&b.other,'需要双方确认且无异议');requireThat(!db.exceptions.some(e=>!['已完成','已驳回'].includes(e.status)&&b.lines.some(m=>m.id===e.source)),'存在未完成异常处理');b.status='已结算';b.sealedAt=now;b.lines.forEach(l=>get('movements',l.id).sealed=true);break;}
      case 'settings':{school();requireThat(['半月','月度'].includes(args.period),'选择结算周期');requireThat(args.sampleRate>0&&args.sampleRate<=100,'抽检比例为 1–100');const before=db.settings.period,nextAt=period(db).end;db.settings={...db.settings,...args,period:before};if(args.period!==before){db.settings.nextPeriod=args.period;db.settings.nextPeriodAt=nextAt;}else{delete db.settings.nextPeriod;delete db.settings.nextPeriodAt;}break;}
      default:throw new Error('未知操作');
    }
    for(const m of db.movements.slice(input.movements.length))refreshOpenBills(db,m);
    db.revision++;db.audit.push({at:now,action,actor:actor.name,role:actor.role});return db;
  }
  const api={seed,execute,prices,referencePrice,available,reserved,progress,money,qty,clone,billLines,period,sampleTasks};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.UCWorkflow=api;
})(typeof window!=='undefined'?window:globalThis);
