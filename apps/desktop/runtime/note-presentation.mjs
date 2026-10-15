/** Display projection only: never changes the file identity, source metadata or body. */
const kinds={explicit_preference:'阅读偏好',preference:'阅读偏好',self_report:'自述理解',observed_performance:'表达与实践',interest:'阅读兴趣'};
const labels={book:'书籍信息',recommendation_run:'导读与推荐记录',reading_evidence:'学习证据',understanding_observation:'理解变化',source:'来源记录',source_record:'来源记录'};
export function notePresentation({id,name,folder,data={}}){
 data=data??{};
 const type=data.object_type;
 const title=typeof data.title==='string'&&data.title.trim()?data.title.trim():name;
 const category=labels[type]??'笔记';
 const prefix=type==='reading_evidence'?(kinds[data.kind]??category):category;
 const displayTitle=type==='book'?'书籍信息':type==='recommendation_run'?category:type==='reading_evidence'?`${prefix} · ${title}`:title;
 const parts=folder.split('/').filter(Boolean);
 // Only the known book namespace can be removed; shared evidence folders retain hierarchy.
 const bookRelativeFolder=parts[0]==='书籍'&&parts.length>=2?parts.slice(2).join('/'):folder;
 return {displayTitle,displayFolder:folder,bookRelativeFolder,displayCategory:category,systemRecord:['recommendation_run','source','source_record'].includes(type),storagePath:id};
}
