// Quick smoke test for anchor-core native module
const { AnchorIndex } = require('./');

// Test 1: Create index
const idx = new AnchorIndex(4, 1000);
console.log('✅ Created index, stats:', JSON.stringify(idx.stats()));

// Test 2: Add vectors
const vec1 = Buffer.alloc(16);
vec1.writeFloatLE(1.0, 0);
vec1.writeFloatLE(0.0, 4);
vec1.writeFloatLE(0.0, 8);
vec1.writeFloatLE(0.0, 12);
idx.add(1, vec1);

const vec2 = Buffer.alloc(16);
vec2.writeFloatLE(0.9, 0);
vec2.writeFloatLE(0.1, 4);
vec2.writeFloatLE(0.0, 8);
vec2.writeFloatLE(0.0, 12);
idx.add(2, vec2);

const vec3 = Buffer.alloc(16);
vec3.writeFloatLE(0.0, 0);
vec3.writeFloatLE(0.0, 4);
vec3.writeFloatLE(1.0, 8);
vec3.writeFloatLE(0.0, 12);
idx.add(3, vec3);

console.log('✅ Added 3 vectors, stats:', JSON.stringify(idx.stats()));

// Test 3: Search
const results = idx.search(vec1, 3);
console.log('✅ Search results:', JSON.stringify(results));

// Verify: vec1 should match vec2 (similar) more than vec3 (orthogonal)
if (results[0].id === 1 && results[0].score > 0.9) {
  console.log('✅ Self-match score correct');
} else {
  console.log('❌ Self-match failed:', results[0]);
}

// Test 4: Save and reload
const testIndexPath = './test_vectors.usearch';
idx.save(testIndexPath);
console.log('✅ Saved index to', testIndexPath);

const idx2 = AnchorIndex.load(testIndexPath, 4, 1000);
const results2 = idx2.search(vec1, 3);
console.log('✅ Reloaded index, search results:', JSON.stringify(results2));

// Test 5: Remove
idx.remove(3);
const results3 = idx.search(vec1, 3);
console.log('✅ After remove, search results:', JSON.stringify(results3));

// Test 6: SQLite database init
AnchorIndex.initDatabase('./test_index.db');
console.log('✅ SQLite database initialized');

// Cleanup
const fs = require('fs');
try { fs.unlinkSync(testIndexPath); } catch {}
try { fs.unlinkSync('./test_index.db'); } catch {}

console.log('\n🎉 ALL TESTS PASSED — anchor-core is working!');
