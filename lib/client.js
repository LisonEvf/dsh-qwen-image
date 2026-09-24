window.__ModuleLoader__.load({
	id: "@lisonevf/dsh-qwen-image",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

"use strict";var Qe=Object.create;var Q=Object.defineProperty;var Ve=Object.getOwnPropertyDescriptor;var We=Object.getOwnPropertyNames;var Je=Object.getPrototypeOf,Ye=Object.prototype.hasOwnProperty;var Xe=(e,t)=>{for(var o in t)Q(e,o,{get:t[o],enumerable:!0})},_e=(e,t,o,i)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of We(t))!Ye.call(e,s)&&s!==o&&Q(e,s,{get:()=>t[s],enumerable:!(i=Ve(t,s))||i.enumerable});return e};var ce=(e,t,o)=>(o=e!=null?Qe(Je(e)):{},_e(t||!e||!e.__esModule?Q(o,"default",{value:e,enumerable:!0}):o,e)),Ze=e=>_e(Q({},"__esModule",{value:!0}),e);var _t={};Xe(_t,{apply:()=>qt,inject:()=>xt,name:()=>ht});module.exports=Ze(_t);var me=ce(require("react"),1);var _=ce(require("react"),1);var ye={routePrefix:"/api/qwen-image",pluginId:"@lisonevf/dsh-qwen-image",presets:[],coldStartSec:85,maxReferenceImages:10};function V(){try{let e=window.__QWEN_IMAGE__;if(e&&typeof e.routePrefix=="string")return{...ye,...e}}catch{}return ye}function N(e){return`${V().routePrefix.replace(/\/$/,"")}${e}`}function C(e){return N(`/raw?id=${encodeURIComponent(e)}`)}function ke(e){return N(`/thumb?id=${encodeURIComponent(e)}`)}function et(e){let t=new URLSearchParams;for(let[i,s]of Object.entries(e))s===void 0||s===""||s===!1||t.set(i,String(s));let o=t.toString();return o?`?${o}`:""}async function ve(e={}){let t=et({q:e.q,kind:e.kind,tag:e.tags?.length?e.tags.join(","):void 0,fav:e.fav?1:void 0,size:e.size,from:e.from,to:e.to,sort:e.sort,order:e.order,limit:e.limit??200,offset:e.offset}),o=await fetch(N(`/gallery.json${t}`));if(!o.ok)throw new Error(`读取相册失败：HTTP ${o.status}`);return await o.json()}async function W(e,t){let o=await fetch(N(e),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)}),i=await o.text(),s={};try{s=i?JSON.parse(i):{}}catch{s={error:i.slice(0,200)}}if(!o.ok){let m=s;throw new Error(m?.error??`HTTP ${o.status}`)}return s}function D(e){return W("/update",e)}function Ne(e,t=!1){return W("/delete",{ids:e,purge:t})}async function Ce(){let e=await fetch(N("/trash.json"));if(!e.ok)throw new Error(`读取回收站失败：HTTP ${e.status}`);return await e.json()}function Re(e){return W("/restore",{ids:e})}function Se(){return W("/recover",{})}async function $e(){let e=await fetch(N("/health"));if(!e.ok)throw new Error(`读取状态失败：HTTP ${e.status}`);return await e.json()}async function Ee(){return(await fetch(N("/unload"),{method:"POST"})).ok}function J(e){if(!Number.isFinite(e))return"";let t=Math.max(0,(Date.now()-e)/1e3);return t<60?"刚刚":t<3600?`${Math.floor(t/60)} 分钟前`:t<86400?`${Math.floor(t/3600)} 小时前`:`${Math.floor(t/86400)} 天前`}function P(e){if(e==null||!Number.isFinite(e))return"—";if(e<60)return`${Math.round(e)} 秒`;let t=e/60;return t<10?`${t.toFixed(1)} 分钟`:`${Math.round(t)} 分钟`}function Te(e){return e==null||!Number.isFinite(e)?"—":e<1024?`${e} B`:e<1024*1024?`${(e/1024).toFixed(0)} KB`:`${(e/1024/1024).toFixed(1)} MB`}function Ie(e){if(typeof e!="string"||!e.trim())return{};try{let t=JSON.parse(e);return t&&typeof t=="object"?t:{}}catch{return{}}}var g=_.createElement;function Pe(e){let t=e.block,o=!!t&&t.kind==="tool-result";return g(o?at:tt,e)}function tt(e){let t=e.block,o=Ie(t?.argsRaw),i=String(o.prompt??""),[s,m]=_.useState(0),r=_.useRef(typeof t?.time=="number"?t.time:Date.now());_.useEffect(()=>{let h=window.setInterval(()=>{m((Date.now()-r.current)/1e3)},1e3);return()=>window.clearInterval(h)},[]);let d=nt(o),q=d?Math.min(97,Math.round(s/d*100)):null;return g("div",{className:"qw-card qw-card--running"},g("div",{className:"qw-card__head"},g("span",{className:"qw-spinner"}),g("span",{className:"qw-card__title"},e.toolName==="image_edit"?"正在改图":"正在生图"),g("span",{className:"qw-card__meta"},`已用 ${P(s)}`)),i?g("div",{className:"qw-card__prompt"},i):null,d?g("div",{className:"qw-progress"},g("div",{className:"qw-progress__bar",style:{width:`${q??0}%`}})):null,g("div",{className:"qw-card__hint"},d?`预计约 ${P(d)}（本机实测标定；每图另含约 ${Math.round(V().coldStartSec)} 秒冷启动）。可切换到「画室」查看进度，或让模型用 image_worker action=logs 查日志。`:"生成中… 本机 P40 实测每张约 3–5 分钟，请耐心等待。"))}function nt(e){let t=V(),o=t.presets??[];if(!o.length)return null;let i=typeof e.preset=="string"?e.preset:void 0;if(i){let r=o.find(d=>d.name===i);if(r)return r.estimatedSec}let s=typeof e.steps=="number"?e.steps:void 0,m=o.find(r=>r.name==="standard");if(s&&m){let r=(m.estimatedSec-t.coldStartSec)/Math.max(1,m.steps-1);return Math.round(t.coldStartSec+s*r)}return m?.estimatedSec??null}function at(e){let t=e.block,o=t?.meta??{},i=t?.isError===!0,s=_.useMemo(()=>Array.isArray(o.ids)&&o.ids.length?o.ids.filter(d=>typeof d=="string"):it(t?.content),[o.ids,t?.content]),[m,r]=_.useState(null);return i?g("div",{className:"qw-card qw-card--error"},g("div",{className:"qw-card__title"},"生成失败"),g("div",{className:"qw-card__hint"},ze(t?.content)||"未知错误")):g("div",{className:"qw-card qw-card--done"},g("div",{className:"qw-card__head"},g("span",{className:"qw-badge qw-badge--ok"},"完成"),g("span",{className:"qw-card__meta"},[o.width&&o.height?`${o.width}×${o.height}`:null,o.steps?`${o.steps} 步`:null,o.seed!=null?`seed ${o.seed}`:null,o.elapsedSec?P(o.elapsedSec):null,o.hasAlpha?"RGBA 透明":null].filter(Boolean).join(" · "))),s.length?g("div",{className:"qw-grid"},s.map(d=>g("figure",{key:d,className:"qw-figure"},g("img",{className:"qw-img",src:C(d),alt:`生成图像 ${d}`,loading:"lazy",style:o.hasAlpha?{backgroundImage:ot}:void 0,onClick:()=>r(d)}),g("figcaption",{className:"qw-figcaption"},g("code",null,d),g("button",{className:"qw-btn qw-btn--mini",onClick:()=>void navigator.clipboard?.writeText(C(d)).catch(()=>{}),title:"复制图片链接"},"复制链接"))))):g("div",{className:"qw-card__hint"},"结果已生成，但未附带可显示的图像 id（可让模型调用 image_result 取回）。"),g("div",{className:"qw-card__hint"},e.toolName==="image_edit"?`可直接说「再改一次…」继续编辑；或让模型用 image_edit image='${s[0]??"latest"}'。`:`可说「把这张的背景换成黄昏海滩」继续改图；或让模型用 image_generate seed=${o.seed??"?"} 复现同款。`),m?g("div",{className:"qw-lightbox",onClick:()=>r(null)},g("img",{className:"qw-lightbox__img",src:C(m),alt:m}),g("div",{className:"qw-lightbox__hint"},"点击任意处关闭")):null)}var ot="linear-gradient(45deg,#8884 25%,transparent 25%),linear-gradient(-45deg,#8884 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#8884 75%),linear-gradient(-45deg,transparent 75%,#8884 75%)";function it(e){let t=ze(e);if(!t)return[];let o=new Set;for(let i of t.matchAll(/id[=:]\s*([A-Za-z0-9_-]+)/g))i[1]&&i[1]!=="latest"&&o.add(i[1]);return[...o]}function ze(e){if(!Array.isArray(e))return"";let t=[];for(let o of e)if(o&&typeof o=="object"&&o.type==="text"){let i=o.text;typeof i=="string"&&t.push(i)}return t.join(`
`)}var l=ce(require("react"),1);var n=l.createElement,st="linear-gradient(45deg,#8884 25%,transparent 25%),linear-gradient(-45deg,#8884 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#8884 75%),linear-gradient(-45deg,transparent 75%,#8884 75%)",rt=[{key:"createdAt",label:"时间"},{key:"bytes",label:"文件大小"},{key:"steps",label:"步数"},{key:"elapsedSec",label:"耗时"},{key:"width",label:"宽度"},{key:"seed",label:"seed"},{key:"id",label:"编号"}],lt=[{key:"day",label:"按日期"},{key:"tag",label:"按标签"},{key:"kind",label:"按类型"},{key:"size",label:"按尺寸"},{key:"none",label:"不分组"}],ct=[{days:void 0,label:"全部时间"},{days:1,label:"今天"},{days:7,label:"近 7 天"},{days:30,label:"近 30 天"}];function Ae(e){let[t,o]=l.useState([]),[i,s]=l.useState(null),[m,r]=l.useState(0),[d,q]=l.useState(null),[h,S]=l.useState(null),[G,p]=l.useState(null),[x,Me]=l.useState(!0),[X,ue]=l.useState(""),[Z,Fe]=l.useState(""),[ee,De]=l.useState("createdAt"),[j,Ge]=l.useState("desc"),[H,je]=l.useState("day"),[$,te]=l.useState(""),[E,ne]=l.useState(void 0),[z,ae]=l.useState([]),[B,ge]=l.useState(!1),[A,pe]=l.useState(void 0),[K,He]=l.useState(!1),[f,T]=l.useState([]),[be,L]=l.useState(null),[oe,ie]=l.useState(null),[se,O]=l.useState(null),[re,M]=l.useState(null),[Be,we]=l.useState(!1),b=l.useCallback(a=>{p(a),window.setTimeout(()=>p(c=>c===a?null:c),2600)},[]);l.useEffect(()=>{let a=window.setTimeout(()=>Fe(X.trim()),250);return()=>window.clearTimeout(a)},[X]);let y=l.useCallback(async()=>{try{let a=A?Date.now()-A*864e5:void 0,c=await ve({q:Z||void 0,kind:$||void 0,tags:z.length?z:void 0,fav:B||void 0,size:E,from:a,sort:ee,order:j,limit:500});o(c.items??[]),s(c.facets??null),r(c.total??c.items?.length??0),S(null);let u=await $e().catch(()=>null);q(u)}catch(a){S(a.message)}finally{Me(!1)}},[Z,$,z,B,E,A,ee,j]);l.useEffect(()=>{y()},[y]),l.useEffect(()=>{let a=window.setInterval(()=>void y(),15e3);return()=>window.clearInterval(a)},[y]),l.useEffect(()=>{T(a=>{let c=a.filter(u=>t.some(w=>w.id===u));return c.length===a.length?a:c})},[t]);let k=l.useCallback((a,c)=>{o(u=>u.map(w=>a.find(F=>F.id===w.id)??w)),c&&s(c)},[]),fe=l.useCallback(async a=>{try{let c=await D({ids:[a.id],favorite:!a.favorite});k(c.items??[],c.facets),b(a.favorite?`已取消收藏 ${a.id}`:`已收藏 ${a.id}`)}catch(c){b(`收藏失败：${c.message}`)}},[k,b]),U=l.useCallback(async(a,c,u=[])=>{try{let w=await D({ids:a,tagsAdd:c,tagsRemove:u});k(w.items??[],w.facets),b(`已更新 ${w.updated?.length??0} 张的标签`)}catch(w){b(`标签更新失败：${w.message}`)}},[k,b]),he=l.useCallback(async(a,c=!1)=>{try{let u=await Ne(a,c);o(w=>w.filter(F=>!u.deleted.includes(F.id))),T([]),u.facets&&s(u.facets),r(w=>Math.max(0,w-u.deleted.length)),b(c?`已彻底删除 ${u.deleted.length} 张`:`已移入回收站 ${u.deleted.length} 张（可还原）`),y()}catch(u){b(`删除失败：${u.message}`)}},[b,y]),Ke=l.useCallback(a=>{T(c=>c.includes(a)?c.filter(u=>u!==a):[...c,a])},[]),xe=l.useCallback(async a=>{if(f.length)try{let c=await D({ids:f,favorite:a});k(c.items??[],c.facets),b(`${a?"已收藏":"已取消收藏"} ${c.updated?.length??0} 张`)}catch(c){b(`操作失败：${c.message}`)}},[f,k,b]),Le=l.useMemo(()=>wt(t,H),[t,H]),Oe=l.useMemo(()=>new Set(f),[f]),I=be?t.findIndex(a=>a.id===be):-1,v=I>=0?t[I]:null,Ue=d?.worker?.state??d?.manager?.state??"未启动",qe=d?.worker?.vram?.free,le=!!(Z||$||E||z.length||B||A);return n("div",{className:"qw-album"},n("header",{className:"qw-album__head"},n("div",{className:"qw-album__titlebox"},n("h2",{className:"qw-album__title"},"历史相册"),n("span",{className:"qw-album__sub"},[`共 ${i?.total??t.length} 张`,le?`显示 ${m} 张`:null,f.length?`已选 ${f.length} 张`:null].filter(Boolean).join(" · "))),n("input",{className:"qw-album__search",type:"search",value:X,placeholder:"搜索提示词 / id / seed / 标签 / 备注…",onChange:a=>ue(a.target.value)}),n("label",{className:"qw-field",title:"排序字段"},n("span",{className:"qw-field__label"},"排序"),n("select",{className:"qw-select",value:ee,onChange:a=>De(a.target.value)},rt.map(a=>n("option",{key:a.key,value:a.key},a.label)))),n("button",{className:"qw-btn qw-btn--mini",title:j==="desc"?"当前：新→旧（点击切换）":"当前：旧→新（点击切换）",onClick:()=>Ge(a=>a==="desc"?"asc":"desc")},j==="desc"?"↓ 降序":"↑ 升序"),n("label",{className:"qw-field",title:"分组（分类）方式"},n("span",{className:"qw-field__label"},"分组"),n("select",{className:"qw-select",value:H,onChange:a=>je(a.target.value)},lt.map(a=>n("option",{key:a.key,value:a.key},a.label)))),n("button",{className:K?"qw-btn qw-btn--mini qw-btn--on":"qw-btn qw-btn--mini",onClick:()=>{He(a=>!a),T([])}},K?"退出选择":"选择"),n("button",{className:"qw-btn qw-btn--mini",onClick:()=>void y()},"刷新")),n("div",{className:"qw-filters"},R("fav","★ 收藏",i?.favorites??0,B,()=>ge(a=>!a)),Y(),n("span",{className:"qw-filters__label"},"类型"),R("kind","全部",i?.total??0,!$,()=>te("")),...(i?.kinds??[]).map(a=>R("kind",ft(a.key),a.count,$===a.key,()=>te($===a.key?"":a.key))),Y(),n("span",{className:"qw-filters__label"},"尺寸"),R("size","全部",i?.total??0,E==null,()=>ne(void 0)),...(i?.sizes??[]).map(a=>R("size",`${a.key}²`,a.count,E===a.key,()=>ne(E===a.key?void 0:a.key))),Y(),n("span",{className:"qw-filters__label"},"时间"),...ct.map(a=>R("range",a.label,0,A===a.days,()=>pe(a.days),!0)),(i?.tags?.length??0)>0?Y():null,(i?.tags?.length??0)>0?n("span",{className:"qw-filters__label"},"标签"):null,...(i?.tags??[]).map(a=>R("tag",a.key,a.count,z.includes(a.key),()=>ae(c=>c.includes(a.key)?c.filter(u=>u!==a.key):[...c,a.key]))),le?n("button",{className:"qw-btn qw-btn--mini qw-btn--ghost",onClick:()=>{ue(""),te(""),ne(void 0),ae([]),ge(!1),pe(void 0)}},"清除筛选"):null),K||f.length?n("div",{className:"qw-batch"},n("span",{className:"qw-batch__count"},`已选 ${f.length} / ${t.length} 张`),n("button",{className:"qw-btn qw-btn--mini",onClick:()=>T(t.map(a=>a.id))},"全选当前列表"),n("button",{className:"qw-btn qw-btn--mini",onClick:()=>T([])},"清除选择"),n("button",{className:"qw-btn qw-btn--mini",disabled:!f.length,onClick:()=>ie({ids:f})},"加标签"),n("button",{className:"qw-btn qw-btn--mini",disabled:!f.length,onClick:()=>void xe(!0)},"收藏"),n("button",{className:"qw-btn qw-btn--mini",disabled:!f.length,onClick:()=>void xe(!1)},"取消收藏"),n("button",{className:"qw-btn qw-btn--mini qw-btn--danger",disabled:!f.length,onClick:()=>M(f)},"删除")):null,h?n("div",{className:"qw-alert"},h):null,x&&!t.length?n("div",{className:"qw-empty"},"载入中…"):null,!x&&!t.length&&!h?n("div",{className:"qw-empty"},le?"没有符合当前筛选条件的作品。":"还没有作品。回到对话里说一句「画一只戴墨镜的柴犬」就会出现在这里。"):null,Le.map(a=>n("section",{className:"qw-grp",key:a.key},H!=="none"?n("h3",{className:"qw-grp__head"},n("span",null,a.label),n("span",{className:"qw-grp__count"},`${a.items.length} 张`)):null,n("div",{className:"qw-album__grid"},a.items.map(c=>n(dt,{key:c.id,item:c,selected:Oe.has(c.id),selectMode:K,onOpen:()=>L(c.id),onToggleSelect:()=>Ke(c.id),onToggleFav:()=>void fe(c),onEditPrompt:()=>O(c),onAddTag:u=>void U([c.id],[u]),onDelete:()=>M([c.id]),onFilterTag:u=>ae(w=>w.includes(u)?w.filter(F=>F!==u):[...w,u])}))))),n("footer",{className:"qw-album__foot"},n("span",{className:"qw-album__foot-item"},`worker：${Ue}`,qe!=null?`，空闲显存 ${(qe/1024).toFixed(1)}G`:""),n("button",{className:"qw-btn qw-btn--mini",title:"删除默认只是移入回收站；这里可以把误删的作品整条还原",onClick:()=>we(!0)},`回收站${d?.trashCount?`（${d.trashCount}）`:""}`),n("button",{className:"qw-btn qw-btn--mini",title:"扫描产物目录：把「磁盘上有、相册里没有」的作品补录进来（宿主在入库前出错留下的孤儿图；manifest 损坏时也是重建通道）",onClick:async()=>{try{let a=await Se();b(a.addedCount?`补录了 ${a.addedCount} 张：${a.added.join("、")}`:`扫描 ${a.scanned} 个 sidecar，没有孤儿作品`),a.addedCount&&y()}catch(a){b(`扫描失败：${a.message}`)}}},"扫描产物"),n("button",{className:"qw-btn qw-btn--mini",title:"卸载模型，把显存还给其它程序（如 llama-server）",onClick:async()=>{await Ee().catch(()=>{}),b("已请求卸载模型"),y()}},"释放显存"),n("span",{className:"qw-album__foot-hint"},"生成与改图请直接在对话里说"),Be?n(bt,{onClose:()=>we(!1),onRestored:()=>{b("已还原"),y()},onPurge:a=>void he(a,!0)}):null),v?n(mt,{item:v,onClose:()=>L(null),onPrev:I>0?()=>L(t[I-1].id):void 0,onNext:I<t.length-1?()=>L(t[I+1].id):void 0,onToggleFav:()=>void fe(v),onAddTag:a=>void U([v.id],[a]),onRemoveTag:a=>void U([v.id],[],[a]),onEditPrompt:()=>O(v),onDelete:()=>M([v.id])}):null,oe?n(gt,{count:oe.ids.length,known:i?.tags?.map(a=>a.key)??[],onCancel:()=>ie(null),onSubmit:a=>{let c=oe.ids;ie(null),a.length&&U(c,a)}}):null,se?n(pt,{item:se,onCancel:()=>O(null),onSubmit:async a=>{let c=se.id;O(null);try{let u=await D({ids:[c],prompt:a.prompt,note:a.note});k(u.items??[],u.facets),b(`已保存 ${c} 的修改`)}catch(u){b(`保存失败：${u.message}`)}}}):null,re?n(ut,{title:`删除 ${re.length} 张？`,message:"默认移入回收站（可还原）；只有「彻底删除」才会真的从磁盘抹掉。",confirmLabel:"移入回收站",danger:!0,onCancel:()=>M(null),onConfirm:()=>{let a=re;M(null),he(a,!1)}}):null,G?n("div",{className:"qw-toast"},G):null)}function dt(e){let{item:t,selected:o,selectMode:i}=e,s=r=>d=>{d.stopPropagation(),r()},m=t.tags??[];return n("figure",{className:`qw-tile${o?" qw-tile--sel":""}`,title:t.prompt,onClick:()=>i?e.onToggleSelect():e.onOpen()},n("div",{className:"qw-tile__wrap"},n("img",{className:"qw-tile__img",src:ke(t.id),alt:t.prompt||t.id,loading:"lazy",decoding:"async",style:t.hasAlpha?{backgroundImage:st}:void 0}),t.favorite?n("span",{className:"qw-tile__star",title:"已收藏"},"★"):null,t.promptEdited?n("span",{className:"qw-tile__flag",title:"提示词或元数据被手工改过"},"✎"):null,i?n("input",{type:"checkbox",className:"qw-tile__check",checked:o,onChange:()=>e.onToggleSelect(),onClick:r=>r.stopPropagation()}):null,n("div",{className:"qw-tile__hover"},n("button",{className:"qw-btn qw-btn--mini",onClick:s(e.onToggleFav)},t.favorite?"取消收藏":"收藏"),n("button",{className:"qw-btn qw-btn--mini",onClick:s(e.onEditPrompt)},"改"),n("button",{className:"qw-btn qw-btn--mini qw-btn--danger",onClick:s(e.onDelete)},"删"))),n("figcaption",{className:"qw-tile__cap"},n("span",{className:"qw-tile__prompt"},t.prompt||"（无提示词）"),m.length?n("span",{className:"qw-tile__tags"},m.slice(0,3).map(r=>n("em",{key:r,className:"qw-tag",title:`按标签「${r}」筛选`,onClick:s(()=>e.onFilterTag(r))},r)),m.length>3?n("em",{className:"qw-tag qw-tag--more"},`+${m.length-3}`):null):null,n("span",{className:"qw-tile__meta"},[`${t.width}×${t.height}`,t.steps?`${t.steps}步`:null,J(t.createdAt),t.kind==="edit"?"改图":null,t.hasAlpha?"RGBA":null].filter(Boolean).join(" · "))))}function mt(e){let{item:t,onClose:o,onPrev:i,onNext:s}=e,[m,r]=l.useState(null),[d,q]=l.useState("");l.useEffect(()=>{let p=x=>{x.key==="Escape"&&o(),x.key==="ArrowLeft"&&i&&i(),x.key==="ArrowRight"&&s&&s()};return window.addEventListener("keydown",p),()=>window.removeEventListener("keydown",p)},[o,i,s]);let h=(p,x)=>{navigator.clipboard?.writeText(x).then(()=>{r(p),window.setTimeout(()=>r(null),1500)},()=>{})},S=p=>x=>{x.stopPropagation(),p()},G=t.tags??[];return n("div",{className:"qw-lightbox",onClick:o},n("img",{className:"qw-lightbox__img",src:C(t.id),alt:t.prompt}),n("div",{className:"qw-lightbox__panel",onClick:p=>p.stopPropagation()},n("div",{className:"qw-lightbox__prompt"},t.prompt||"（无提示词）"),t.note?n("div",{className:"qw-lightbox__note"},`备注：${t.note}`):null,n("div",{className:"qw-lightbox__facts"},[`${t.width}×${t.height}`,`${t.steps} 步`,`seed ${t.seed}`,P(t.elapsedSec),t.steadyStepSec?`稳态 ${t.steadyStepSec}s/步`:null,Te(t.bytes),t.peakVramMiB?`峰值显存 ${t.peakVramMiB}MiB`:null,t.device?`${t.device}/${t.dtype}`:null,t.kind==="edit"?"改图":"生图",t.promptEdited?"提示词已手改":null].filter(Boolean).join(" · ")),n("div",{className:"qw-lightbox__tags"},G.map(p=>n("em",{key:p,className:"qw-tag"},p,n("button",{className:"qw-tag__x",title:"移除该标签",onClick:S(()=>e.onRemoveTag(p))},"×"))),n("input",{className:"qw-input qw-input--mini",value:d,placeholder:"加标签，回车确认",onChange:p=>q(p.target.value),onKeyDown:p=>{if(p.key!=="Enter")return;let x=d.trim();x&&(e.onAddTag(x),q(""))}})),n("div",{className:"qw-lightbox__actions"},i?n("button",{className:"qw-btn qw-btn--mini",onClick:i},"← 上一张"):null,e.onToggleFav?n("button",{className:"qw-btn qw-btn--mini",onClick:e.onToggleFav},t.favorite?"★ 取消收藏":"☆ 收藏"):null,n("button",{className:"qw-btn qw-btn--mini",onClick:e.onEditPrompt},"改提示词/备注"),n("button",{className:"qw-btn qw-btn--mini",onClick:()=>h("id",t.id)},m==="id"?"已复制 id":"复制 id"),n("button",{className:"qw-btn qw-btn--mini",onClick:()=>h("prompt",t.prompt??"")},m==="prompt"?"已复制提示词":"复制提示词"),n("a",{className:"qw-btn qw-btn--mini",href:C(t.id),download:`${t.id}.png`},"下载原图"),n("button",{className:"qw-btn qw-btn--mini qw-btn--danger",onClick:e.onDelete},"删除"),s?n("button",{className:"qw-btn qw-btn--mini",onClick:s},"下一张 →"):null),n("code",{className:"qw-lightbox__id"},t.id),n("div",{className:"qw-lightbox__hint"},"Esc 关闭 · ←/→ 翻页 · 点背景关闭")))}function ut(e){return n("div",{className:"qw-modal",onClick:e.onCancel},n("div",{className:"qw-modal__box",onClick:t=>t.stopPropagation()},n("h3",{className:"qw-modal__title"},e.title),n("p",{className:"qw-modal__msg"},e.message),n("div",{className:"qw-modal__actions"},n("button",{className:"qw-btn",onClick:e.onCancel},"取消"),n("button",{className:e.danger?"qw-btn qw-btn--danger":"qw-btn",onClick:e.onConfirm},e.confirmLabel))))}function gt(e){let[t,o]=l.useState(""),i=l.useMemo(()=>t.split(/[,，\s]+/).map(s=>s.trim()).filter(Boolean),[t]);return n("div",{className:"qw-modal",onClick:e.onCancel},n("div",{className:"qw-modal__box",onClick:s=>s.stopPropagation()},n("h3",{className:"qw-modal__title"},`给 ${e.count} 张加标签`),n("p",{className:"qw-modal__msg"},"逗号或空格分隔可一次加多个；已存在的标签会自动去重。"),n("input",{className:"qw-input",autoFocus:!0,value:t,placeholder:"例如：柴犬, 已定稿",onChange:s=>o(s.target.value),onKeyDown:s=>{s.key==="Enter"&&i.length&&e.onSubmit(i)}}),e.known.length?n("div",{className:"qw-modal__known"},n("span",{className:"qw-field__label"},"已有标签："),e.known.slice(0,20).map(s=>n("em",{key:s,className:"qw-tag qw-tag--click",onClick:()=>o(m=>m?`${m}, ${s}`:s)},s))):null,n("div",{className:"qw-modal__actions"},n("button",{className:"qw-btn",onClick:e.onCancel},"取消"),n("button",{className:"qw-btn",disabled:!i.length,onClick:()=>e.onSubmit(i)},i.length?`加 ${i.length} 个标签`:"加标签"))))}function pt(e){let[t,o]=l.useState(e.item.prompt??""),[i,s]=l.useState(e.item.note??"");return n("div",{className:"qw-modal",onClick:e.onCancel},n("div",{className:"qw-modal__box qw-modal__box--wide",onClick:m=>m.stopPropagation()},n("h3",{className:"qw-modal__title"},`改 ${e.item.id} 的提示词 / 备注`),n("p",{className:"qw-modal__msg"},"只改**记录**，不动已生成的图；改过的记录会标 ✎，原提示词不再等于产出参数。"),n("textarea",{className:"qw-textarea",rows:6,value:t,onChange:m=>o(m.target.value)}),n("input",{className:"qw-input",value:i,placeholder:"备注（可选）",onChange:m=>s(m.target.value)}),n("div",{className:"qw-modal__actions"},n("button",{className:"qw-btn",onClick:e.onCancel},"取消"),n("button",{className:"qw-btn",onClick:()=>e.onSubmit({prompt:t,note:i})},"保存"))))}function bt(e){let[t,o]=l.useState(null),[i,s]=l.useState(!1),m=l.useCallback(async()=>{let r=await Ce().catch(()=>null);o(r?.items??[])},[]);return l.useEffect(()=>{m()},[m]),n("div",{className:"qw-modal",onClick:e.onClose},n("div",{className:"qw-modal__box qw-modal__box--wide",onClick:r=>r.stopPropagation()},n("h3",{className:"qw-modal__title"},`回收站（${t?.length??0}）`),n("p",{className:"qw-modal__msg"},"删除默认是移到这里，PNG/缩略图/sidecar 都按原文件名存放，可以整条还原。「彻底删除」不可撤销。"),t==null?n("div",{className:"qw-empty"},"载入中…"):t.length===0?n("div",{className:"qw-empty"},"回收站是空的。"):n("ul",{className:"qw-trash"},t.map(r=>n("li",{key:r.id,className:"qw-trash__row"},n("code",{className:"qw-trash__id"},r.id),n("span",{className:"qw-trash__meta"},`${r.width}×${r.height} · ${J(r.deletedAt)}`),n("span",{className:"qw-trash__prompt"},r.prompt||"（无提示词）"),n("button",{className:"qw-btn qw-btn--mini",disabled:i,onClick:async()=>{s(!0),await Re([r.id]).catch(()=>{}),await m(),s(!1),e.onRestored()}},"还原"),n("button",{className:"qw-btn qw-btn--mini qw-btn--danger",disabled:i,onClick:async()=>{s(!0),e.onPurge([r.id]),await m(),s(!1)}},"彻底删除")))),n("div",{className:"qw-modal__actions"},n("button",{className:"qw-btn",onClick:e.onClose},"关闭"))))}function wt(e,t){if(t==="none")return[{key:"all",label:"全部",items:e}];let o=new Map,i=(r,d,q)=>{let h=o.get(r)??{label:d,items:[]};h.items.push(q),o.set(r,h)};for(let r of e)if(t==="day"){let d=new Date(Number(r.createdAt)||0),q=S=>String(S).padStart(2,"0"),h=`${d.getFullYear()}-${q(d.getMonth()+1)}-${q(d.getDate())}`;i(h,`${h}（${J(r.createdAt)}）`,r)}else if(t==="kind")i(r.kind||"generate",r.kind==="edit"?"改图":"生图",r);else if(t==="size"){let d=Math.max(r.width,r.height);i(String(d),`${d}²`,r)}else{let d=r.tags??[];d.length?i(d[0],`#${d[0]}`,r):i("__none__","未分类",r)}let s=t==="day"?"desc":t==="size"?"asc":"count",m=[...o.entries()].map(([r,d])=>({key:r,label:d.label,items:d.items}));return s==="desc"?m.sort((r,d)=>d.key.localeCompare(r.key)):s==="asc"?m.sort((r,d)=>Number(r.key)-Number(d.key)):m.sort((r,d)=>r.key==="__none__"?1:d.key==="__none__"?-1:d.items.length-r.items.length),m}function ft(e){return e==="edit"?"改图":e==="generate"?"生图":e||"未标注"}function R(e,t,o,i,s,m=!1){return n("button",{key:`${e}:${t}`,className:`qw-chip${i?" qw-chip--on":""}`,onClick:s},t,!m&&o?n("span",{className:"qw-chip__n"},o):null)}function Y(){return n("span",{className:"qw-filters__sep"})}var de=`
.qw-card {
  border: 1px solid var(--ds-border, rgba(127,127,127,.28));
  border-radius: 10px;
  padding: 10px 12px;
  margin: 6px 0;
  background: var(--ds-surface, rgba(127,127,127,.06));
  font-size: 13px;
  line-height: 1.5;
}
.qw-card--error { border-color: var(--ds-danger, #d9534f); }
.qw-card__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.qw-card__title { font-weight: 600; }
.qw-card__meta { opacity: .72; font-size: 12px; }
.qw-card__prompt {
  margin-top: 6px; padding: 6px 8px; border-radius: 6px;
  background: rgba(127,127,127,.09); white-space: pre-wrap; word-break: break-word;
}
.qw-card__hint { margin-top: 6px; font-size: 12px; opacity: .7; }

.qw-spinner {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid rgba(127,127,127,.35);
  border-top-color: var(--ds-accent, #4a9eff);
  animation: qw-spin .8s linear infinite;
  display: inline-block; flex: none;
}
@keyframes qw-spin { to { transform: rotate(360deg); } }

.qw-progress {
  margin-top: 8px; height: 4px; border-radius: 2px;
  background: rgba(127,127,127,.2); overflow: hidden;
}
.qw-progress__bar {
  height: 100%; background: var(--ds-accent, #4a9eff);
  transition: width .6s ease;
}

.qw-badge {
  font-size: 11px; padding: 1px 7px; border-radius: 999px;
  background: rgba(127,127,127,.18);
}
.qw-badge--ok { background: rgba(60,180,110,.22); color: var(--ds-success, #2e9e63); }

.qw-grid { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
.qw-figure { margin: 0; display: flex; flex-direction: column; gap: 4px; }
.qw-img {
  max-width: min(360px, 100%); max-height: 360px; border-radius: 8px;
  cursor: zoom-in; display: block; background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  border: 1px solid rgba(127,127,127,.22);
}
.qw-figcaption { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: .8; }
.qw-figcaption code { font-size: 11px; }

.qw-btn {
  font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 6px;
  border: 1px solid rgba(127,127,127,.32);
  background: rgba(127,127,127,.1); color: inherit; cursor: pointer;
}
.qw-btn:hover:not(:disabled) { background: rgba(127,127,127,.2); }
.qw-btn:disabled { opacity: .5; cursor: default; }
.qw-btn--mini { font-size: 11px; padding: 1px 7px; }
a.qw-btn { text-decoration: none; display: inline-block; }

/* 点图放大的灯箱（只有图片，没有面板） */
.qw-lightbox {
  position: fixed; inset: 0; z-index: 9999;
  background: rgba(0,0,0,.82);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; cursor: zoom-out; padding: 24px;
}
.qw-lightbox__img {
  max-width: 92vw; max-height: 82vh; object-fit: contain;
  border-radius: 8px; background: #fff;
}
.qw-lightbox__hint { color: rgba(255,255,255,.7); font-size: 12px; }
.qw-lightbox__actions { display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
.qw-lightbox__panel { cursor: default; }

/* ══════════════════════════════════════════════════════════════════
   历史相册（conversation.view）
   回顾 + 管理：网格紧凑能一眼扫过去，筛选/排序/分组在顶部一行解决，
   改动（标签/提示词/收藏）就地生效，删除默认进回收站。
   ══════════════════════════════════════════════════════════════════ */
.qw-album {
  padding: 12px 16px 28px;
  overflow-y: auto;
  height: 100%;
  font-size: 13px;
  display: flex;
  flex-direction: column;
}

.qw-album__head {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 10px; border-bottom: 1px solid rgba(127,127,127,.2);
  position: sticky; top: 0; z-index: 2;
  background: var(--ds-surface, transparent);
  backdrop-filter: blur(6px);
}
.qw-album__titlebox { display: flex; flex-direction: column; line-height: 1.2; }
.qw-album__title { margin: 0; font-size: 15px; font-weight: 600; }
.qw-album__sub { font-size: 11px; opacity: .6; }
.qw-album__search {
  flex: 1 1 160px; min-width: 120px; max-width: 320px;
  font: inherit; font-size: 12px; padding: 4px 9px; border-radius: 7px;
  border: 1px solid rgba(127,127,127,.3);
  background: rgba(127,127,127,.08); color: inherit;
}
.qw-album__search:focus { outline: none; border-color: var(--ds-accent, #4a9eff); }
.qw-album__head > .qw-btn { margin-left: auto; }

.qw-album__grid {
  display: grid; gap: 10px; margin-top: 12px;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
}

/* 网格瓦片：缩略图为方形容器，图按 cover 填充，扫视更整齐 */
.qw-tile {
  margin: 0; cursor: zoom-in;
  border: 1px solid rgba(127,127,127,.2); border-radius: 9px;
  overflow: hidden; display: flex; flex-direction: column;
  background: rgba(127,127,127,.05);
  transition: transform .12s ease, border-color .12s ease;
}
.qw-tile:hover { transform: translateY(-2px); border-color: rgba(127,127,127,.42); }
.qw-tile__img {
  width: 100%; aspect-ratio: 1; object-fit: cover; display: block;
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}
.qw-tile__cap { padding: 5px 7px; display: flex; flex-direction: column; gap: 2px; }
.qw-tile__prompt {
  font-size: 11px; opacity: .85;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.qw-tile__meta { font-size: 10px; opacity: .55; }

.qw-album__foot {
  margin-top: auto; padding-top: 12px;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  font-size: 11px; opacity: .7;
  border-top: 1px solid rgba(127,127,127,.15);
}
.qw-album__foot-item { font-variant-numeric: tabular-nums; }
.qw-album__foot-hint { margin-left: auto; opacity: .8; }

/* ── 表单控件（排序/分组/标签输入）────────────────────────────── */
.qw-field { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.qw-field__label { opacity: .6; }
.qw-select, .qw-input, .qw-textarea {
  font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 6px;
  border: 1px solid rgba(127,127,127,.3);
  background: rgba(127,127,127,.08); color: inherit;
}
.qw-select:focus, .qw-input:focus, .qw-textarea:focus {
  outline: none; border-color: var(--ds-accent, #4a9eff);
}
.qw-textarea { width: 100%; resize: vertical; line-height: 1.5; }
.qw-input--mini { font-size: 11px; padding: 1px 6px; }
.qw-btn--on { background: var(--ds-accent, #4a9eff); border-color: transparent; color: #fff; }
.qw-btn--danger { color: var(--ds-danger, #d9534f); border-color: rgba(217,83,79,.5); }
.qw-btn--danger:hover:not(:disabled) { background: rgba(217,83,79,.16); }
.qw-btn--ghost { opacity: .8; }

/* ── 筛选条（计数取全量口径）──────────────────────────────────── */
.qw-filters {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  padding: 8px 0 2px; font-size: 11px;
}
.qw-filters__label { opacity: .55; margin-right: 1px; }
.qw-filters__sep {
  width: 1px; height: 14px; margin: 0 4px;
  background: rgba(127,127,127,.28);
}
.qw-chip {
  font: inherit; font-size: 11px; padding: 2px 8px; border-radius: 999px;
  border: 1px solid rgba(127,127,127,.3);
  background: rgba(127,127,127,.07); color: inherit; cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
}
.qw-chip:hover { background: rgba(127,127,127,.18); }
.qw-chip--on {
  background: var(--ds-accent, #4a9eff); border-color: transparent; color: #fff;
}
.qw-chip__n { opacity: .7; font-variant-numeric: tabular-nums; }

/* ── 批量操作条 ───────────────────────────────────────────────── */
.qw-batch {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  margin-top: 8px; padding: 6px 9px; border-radius: 8px;
  background: rgba(74,158,255,.12);
  border: 1px solid rgba(74,158,255,.3);
}
.qw-batch__count { font-size: 11px; font-weight: 600; margin-right: auto; }

/* ── 分组（分类）──────────────────────────────────────────────── */
.qw-grp { margin-top: 14px; }
.qw-grp__head {
  margin: 0 0 6px; font-size: 12px; font-weight: 600;
  display: flex; align-items: baseline; gap: 8px;
  opacity: .9;
}
.qw-grp__count { font-size: 10px; font-weight: 400; opacity: .55; }

/* ── 瓦片上的状态与悬浮操作 ───────────────────────────────────── */
.qw-tile__wrap { position: relative; }
.qw-tile--sel { border-color: var(--ds-accent, #4a9eff); box-shadow: 0 0 0 2px rgba(74,158,255,.35); }
.qw-tile__star {
  position: absolute; top: 4px; left: 6px; font-size: 13px; line-height: 1;
  color: #f5c542; text-shadow: 0 1px 3px rgba(0,0,0,.6);
}
.qw-tile__flag {
  position: absolute; top: 4px; right: 6px; font-size: 11px;
  color: #fff; background: rgba(0,0,0,.45); border-radius: 4px; padding: 0 4px;
}
.qw-tile__check {
  position: absolute; bottom: 6px; right: 6px; width: 15px; height: 15px;
  cursor: pointer; accent-color: var(--ds-accent, #4a9eff);
}
.qw-tile__hover {
  position: absolute; left: 0; right: 0; bottom: 0;
  display: flex; gap: 4px; padding: 5px;
  background: linear-gradient(transparent, rgba(0,0,0,.62));
  opacity: 0; transition: opacity .12s ease;
}
.qw-tile:hover .qw-tile__hover, .qw-tile--sel .qw-tile__hover { opacity: 1; }
.qw-tile__hover .qw-btn {
  background: rgba(255,255,255,.9); color: #222; border-color: transparent;
}
.qw-tile__tags { display: flex; gap: 3px; flex-wrap: wrap; }
.qw-tag {
  font-style: normal; font-size: 10px; padding: 0 5px; border-radius: 999px;
  background: rgba(127,127,127,.2); display: inline-flex; align-items: center; gap: 2px;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.qw-tag--click { cursor: pointer; }
.qw-tag--click:hover { background: rgba(127,127,127,.34); }
.qw-tag--more { opacity: .6; }
.qw-tag__x {
  font: inherit; font-size: 11px; line-height: 1; border: none; background: none;
  color: inherit; cursor: pointer; opacity: .6; padding: 0 0 0 2px;
}
.qw-tag__x:hover { opacity: 1; }

/* ── 弹窗 / 回收站 / 提示 ─────────────────────────────────────── */
.qw-modal {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.qw-modal__box {
  background: var(--ds-surface, #1b1b1f); color: inherit;
  border: 1px solid rgba(127,127,127,.3); border-radius: 10px;
  padding: 14px 16px; min-width: 280px; max-width: 460px; width: 100%;
  box-shadow: 0 12px 40px rgba(0,0,0,.45);
  display: flex; flex-direction: column; gap: 8px;
  max-height: 82vh; overflow-y: auto;
}
.qw-modal__box--wide { max-width: 620px; }
.qw-modal__title { margin: 0; font-size: 14px; font-weight: 600; }
.qw-modal__msg { margin: 0; font-size: 12px; opacity: .72; line-height: 1.5; }
.qw-modal__actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 4px; }
.qw-modal__known { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; font-size: 11px; }
.qw-trash { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.qw-trash__row {
  display: grid; grid-template-columns: auto auto 1fr auto auto; gap: 6px;
  align-items: center; font-size: 11px;
  padding: 5px 6px; border-radius: 6px; background: rgba(127,127,127,.09);
}
.qw-trash__id { font-size: 11px; }
.qw-trash__meta { opacity: .6; white-space: nowrap; }
.qw-trash__prompt {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85;
}
.qw-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  z-index: 10001; padding: 7px 14px; border-radius: 999px; font-size: 12px;
  background: rgba(20,20,24,.92); color: #fff;
  box-shadow: 0 6px 20px rgba(0,0,0,.45);
}

/* 灯箱里的标签与备注 */
.qw-lightbox__tags {
  display: flex; align-items: center; gap: 5px; flex-wrap: wrap;
  justify-content: center; margin-top: 8px; color: #fff;
}
.qw-lightbox__note { color: rgba(255,255,255,.8); font-size: 12px; text-align: center; }
`;var ht="@lisonevf/dsh-qwen-image/client",xt=["slots"];function qt(e){try{let o=e.get("styles");if(o&&typeof o.insert=="function")o.insert(de);else{let i=document.createElement("style");i.setAttribute("data-qwen-image",""),i.textContent=de,document.head.appendChild(i)}}catch{}let t=e.get("slots");if(!t){console.warn("[qwen-image/client] slots 服务不可用，未注册任何界面");return}for(let o of["image_generate","image_edit"])try{t.inject("tool.call.toolview",()=>{t.register({name:"tool.call.toolview",key:o},i=>me.createElement(Pe,{...i,toolName:o}))})}catch(i){console.warn(`[qwen-image/client] 注册 ${o} 卡片失败：`,i.message)}try{t.inject("conversation.view",()=>{t.register({name:"conversation.view",id:"qwen-image",order:6,label:"相册"},o=>me.createElement(Ae,o))})}catch(o){console.warn("[qwen-image/client] 注册相册视图失败：",o.message)}}

		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
