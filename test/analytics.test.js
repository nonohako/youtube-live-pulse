'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {preferences,comparison}=require('../src/renderer/analytics-math');
const now=new Date(2026,8,17,12).getTime();
test('chart preferences validate independent ranges and modes',()=>{
 const prefs=preferences({subscriberRange:'7d',videoRange:'90d',compareRange:'all',videoMode:'daily',compareMetric:'change'});
 assert.equal(prefs.subscriberRange,'7d');assert.equal(prefs.videoRange,'90d');assert.equal(prefs.videoMode,'daily');assert.equal(prefs.compareRange,'all');
 assert.equal(preferences({videoRange:'invalid',subscriberMode:'invalid'}).videoRange,'30d');
 assert.equal(preferences(null).subscriberMode,'samples');
});
test('comparison uses actual time and independent baselines without filling missing dates',()=>{
 const at=d=>new Date(2026,8,d,10).toISOString();
 const items=[{title:'A',samples:[{at:at(10),count:100},{at:at(12),count:150},{at:at(16),count:180}]},{title:'B',samples:[{at:at(13),count:400},{at:at(17),count:390}]}];
 const result=comparison(items,'7d','samples','change',now);
 assert.deepEqual(result.series[0].samples.map(s=>s.value),[0,30]);
 assert.deepEqual(result.series[1].samples.map(s=>s.value),[0,-10]);
 assert.equal(result.series[0].first.timestamp,new Date(at(12)).getTime());
 assert.equal(result.series[1].samples.length,2);assert.equal(result.low,-10);
});
test('daily comparison retains last observation per local day and does not mutate original',()=>{
 const samples=[{at:new Date(2026,8,16,1).toISOString(),count:10},{at:new Date(2026,8,16,21).toISOString(),count:30},{at:new Date(2026,8,17,9).toISOString(),count:40}];
 const original=JSON.stringify(samples);const result=comparison([{samples}],'7d','daily','total',now);
 assert.deepEqual(result.series[0].samples.map(s=>s.count),[30,40]);
 assert.equal(new Date(result.series[0].samples[0].timestamp).getHours(),0);assert.equal(JSON.stringify(samples),original);
 assert.equal(comparison([{samples:[]}],'all','daily','change',now).series[0].change,null);
});

test('interval analytics preserve gaps, negative changes and insufficient baselines',()=>{
 const {intervalSummary}=require('../src/renderer/analytics-math');
 const samples=[{at:'2026-09-01T12:00:00Z',count:120},{at:'2026-09-03T12:00:00Z',count:100}];
 assert.equal(intervalSummary(samples).perDay,-10);
 assert.equal(intervalSummary(samples).change,-20);
 assert.equal(intervalSummary(samples.slice(0,1)).change,null);
 assert.equal(intervalSummary([{at:samples[0].at,count:0},{at:samples[1].at,count:20}]).percent,null);
});

test('hour axis preserves every hourly tick and emphasizes local midnight',()=>{
 const {detailTicks,buildTimeWindowAxis}=require('../src/renderer/chart-math');
 const start=new Date(2026,8,15,19,30).getTime(),end=new Date(2026,8,17,3,30).getTime();
 const ticks=detailTicks(buildTimeWindowAxis(start,end),'samples');
 assert.equal(ticks.length,32);
 for(let i=1;i<ticks.length;i++)assert.equal(ticks[i].time-ticks[i-1].time,3600000);
 assert.equal(ticks.filter(t=>t.major).length,2);
 assert.ok(ticks.filter(t=>t.major).every(t=>new Date(t.time).getHours()===0));
 assert.ok(detailTicks(buildTimeWindowAxis(start,end),'daily').every(t=>t.major));
});

test('comparison daily presentation preserves raw summary, baseline and actual observation time',()=>{
 const at=(day,hour)=>new Date(2026,8,day,hour).toISOString();
 const samples=[{at:at(15,12),count:100},{at:at(15,23),count:200},{at:at(16,12),count:300},{at:at(18,12),count:999}];
 const before=JSON.stringify(samples);
 const raw=comparison([{samples}],'7d','samples','change',now).series[0];
 const daily=comparison([{samples}],'7d','daily','change',now).series[0];
 for(const key of ['first','last','change','perDay','percent','baseline']) assert.deepEqual(daily[key],raw[key]);
 assert.equal(daily.change,200); assert.equal(daily.perDay,200);
 assert.deepEqual(daily.samples.map(s=>s.value),[100,200]);
 assert.equal(daily.samples[0].observedAt,Date.parse(at(15,23)));
 assert.equal(new Date(daily.samples[0].timestamp).getHours(),0);
 assert.equal(JSON.stringify(samples),before);
});

test('comparison keeps same-day rate and missing or negative baselines across display modes',()=>{
 const at=(day,hour)=>new Date(2026,8,day,hour).toISOString();
 for(const samples of [[],[{at:at(16,9),count:100}],[{at:at(16,9),count:100},{at:at(16,21),count:70}],[{at:at(1,9),count:900},{at:at(12,9),count:0},{at:at(16,9),count:20}]]) {
  const raw=comparison([{samples}],'7d','samples','change',now).series[0];
  const daily=comparison([{samples}],'7d','daily','change',now).series[0];
  for(const key of ['change','perDay','percent','baseline']) assert.equal(daily[key],raw[key]);
 }
 const result=comparison([{samples:[{at:at(16,9),count:100},{at:at(16,21),count:70}]}],'7d','daily','change',now).series[0];
 assert.equal(result.samples.length,1); assert.equal(result.change,-30); assert.equal(result.perDay,-60);
});
test('plot continuity retains adjacent real points without altering visible-window statistics',()=>{
 const {plotSamples,filterSamplesInTimeWindow}=require('../src/renderer/chart-math');
 const points=[0,10,20,30].map(h=>({at:new Date(2026,8,15,h).toISOString(),count:h+100}));
 const from=new Date(2026,8,15,11).getTime(),to=new Date(2026,8,15,25).getTime();
 assert.deepEqual(plotSamples(points,from,to).map(s=>s.count),[110,120,130]);
 assert.deepEqual(filterSamplesInTimeWindow(points,from,to).map(s=>s.count),[120]);
 assert.equal(points.length,4);
});

test('subscriber forecast uses completed-day drift, widens its band and finds the next milestone',()=>{
 const {forecast,nextMilestone}=require('../src/renderer/analytics-math');
 const day=d=>new Date(2026,8,d,23).toISOString();
 const samples=[];for(let d=1;d<=20;d++)samples.push({at:day(d),count:100000+d*1000+(d%2?300:-300)});
 samples.push({at:new Date(2026,8,21,9).toISOString(),count:999999}); // today's partial is only the anchor
 const now=new Date(2026,8,21,10).getTime();
 const result=forecast(samples,'subscriber',now);
 assert.equal(result.ready,true);
 assert.ok(Math.abs(result.rate-1000)<60);
 assert.equal(result.anchor.count,999999);
 const week=result.project(7),month=result.project(30);
 assert.ok(week.low<week.value&&week.value<week.high);
 assert.ok(month.high-month.low>week.high-week.low);
 assert.equal(result.project(0).value,999999);
 assert.equal(nextMilestone(1220000),1300000);assert.equal(nextMilestone(95000),96000);assert.equal(nextMilestone(3),10);
 assert.ok(Math.abs(result.recent-1000)<200);
 assert.equal(forecast(samples.slice(0,4),'subscriber',now).ready,false);
});

test('video forecast decays daily gains and never reports an unreachable milestone date',()=>{
 const {forecast}=require('../src/renderer/analytics-math');
 const samples=[];let total=500000;
 for(let d=1;d<=16;d++){total+=Math.round(80000*Math.pow(0.8,d));samples.push({at:new Date(2026,8,d,23).toISOString(),count:total});}
 const now=new Date(2026,8,17,8).getTime();
 const result=forecast(samples,'video',now);
 assert.equal(result.ready,true);
 assert.ok(Math.abs(result.halfLifeDays-Math.log(2)/-Math.log(0.8))<0.2);
 const gain=result.project(30).value-total, remaining=80000*Math.pow(0.8,17)/(1-0.8);
 assert.ok(Math.abs(gain-remaining)/remaining<0.15);
 assert.ok(result.momentum<0);
 const flat=forecast(samples.map(s=>({...s,count:1000})),'video',now);
 assert.equal(flat.ready,false);
 const fading=forecast(samples,'video',now);
 if(fading.milestone.days===null)assert.equal(fading.milestone.timestamp,null);
});
