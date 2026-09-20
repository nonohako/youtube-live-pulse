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
 assert.equal(preferences({videoMetric:'change',subscriberMetric:'bad'}).videoMetric,'change');
 assert.equal(preferences({subscriberMetric:'bad'}).subscriberMetric,'total');
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
test('plot continuity retains adjacent real points without altering visible-window statistics',()=>{
 const {plotSamples,filterSamplesInTimeWindow}=require('../src/renderer/chart-math');
 const points=[0,10,20,30].map(h=>({at:new Date(2026,8,15,h).toISOString(),count:h+100}));
 const from=new Date(2026,8,15,11).getTime(),to=new Date(2026,8,15,25).getTime();
 assert.deepEqual(plotSamples(points,from,to).map(s=>s.count),[110,120,130]);
 assert.deepEqual(filterSamplesInTimeWindow(points,from,to).map(s=>s.count),[120]);
 assert.equal(points.length,4);
});
