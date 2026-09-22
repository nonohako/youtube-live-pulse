'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ChannelMonitor}=require('../src/lib/monitor');
const {createDefaultData}=require('../src/lib/defaults');

test('polling preserves imported dates older than a year and more than 500 local samples',async()=>{
 const data=createDefaultData();
 const original=Array.from({length:600},(_,i)=>({at:new Date(Date.UTC(2023,0,i+1)).toISOString(),count:1000+i}));
 data.channels[0].subscriberHistory=structuredClone(original);
 const store={data,update:mutate=>mutate(data)};
 const monitor=new ChannelMonitor({store,onState:()=>{},onNotify:()=>{},onOpen:()=>{},projectChannel:c=>c,
  fetchSnapshot:async()=>({metadata:{title:'Preserved channel',subscriberCount:2000},checkedAt:'2026-09-22T12:00:00Z',warnings:[],upcoming:[],recentVideos:[],recentPosts:[],videoStats:[]})});
 await monitor.runNow();
 assert.equal(monitor.runtime.get(data.channels[0].id).status,'online');
 assert.equal(data.channels[0].subscriberHistory.length,601);
 assert.deepEqual(data.channels[0].subscriberHistory.slice(0,600),original);
 await monitor.runNow();
 assert.equal(data.channels[0].subscriberHistory.length,601);
 assert.deepEqual(data.channels[0].subscriberHistory.slice(0,600),original);
});
