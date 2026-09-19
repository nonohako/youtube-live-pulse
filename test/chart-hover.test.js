'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {nearest,scheduler}=require('../src/renderer/chart-hover');
test('hover binary lookup chooses actual nearest points at boundaries and gaps',()=>{
 const p=[{x:1},{x:5},{x:20}];assert.equal(nearest(p,-1),p[0]);assert.equal(nearest(p,30),p[2]);assert.equal(nearest(p,4),p[1]);assert.equal(nearest(p,12),p[1]);assert.equal(nearest([],1),null);
 const timed=[{timestamp:100},{timestamp:500}];assert.equal(nearest(timed,450,'timestamp'),timed[1]);
});
test('hover coalesces bursts to the latest pointer and cancels after leaving',()=>{
 const frames=new Map();let id=0;const h=scheduler(fn=>{frames.set(++id,fn);return id;},key=>frames.delete(key));let result=[];
 for(let i=0;i<100;i++)h.move('chart',{x:i},e=>result.push(e.x));
 assert.equal(frames.size,1);const frame=frames.values().next().value;frames.clear();frame();assert.deepEqual(result,[99]);
 h.move('chart',{x:101},e=>result.push(e.x));h.clear('chart');assert.equal(frames.size,0);assert.deepEqual(result,[99]);
});
test('hover lookup is logarithmic with a large history',()=>{
 let reads=0;const p=Array.from({length:100000},(_,i)=>({get x(){reads++;return i;}}));assert.equal(nearest(p,75321),p[75321]);assert.ok(reads<30);
});
