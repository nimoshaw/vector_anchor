// anchor-core/src/lib.rs
// Main entry point - N-API class export

#[macro_use]
extern crate napi_derive;

mod index;
mod math;
mod storage;
mod types;

use std::sync::Arc;
use napi::{bindgen_prelude::*, Error, Result};
use parking_lot::RwLock;
use usearch::Index;

use types::{AnchorStats, SearchResult};

/// AnchorIndex - High-performance vector index with HNSW + SQLite
#[napi]
pub struct AnchorIndex {
    inner: Arc<RwLock<Index>>,
    dimensions: u32,
}

#[napi]
impl AnchorIndex {
    /// Create a new empty index
    #[napi(constructor)]
    pub fn new(dim: u32, capacity: u32) -> Result<Self> {
        let idx = index::create_index(dim as usize, capacity as usize)
            .map_err(|e| Error::from_reason(e))?;

        Ok(Self {
            inner: Arc::new(RwLock::new(idx)),
            dimensions: dim,
        })
    }

    /// Load an existing index from disk
    #[napi(factory)]
    pub fn load(index_path: String, dim: u32, capacity: u32) -> Result<Self> {
        let idx = index::load_index(&index_path, dim as usize, capacity as usize)
            .map_err(|e| Error::from_reason(e))?;

        Ok(Self {
            inner: Arc::new(RwLock::new(idx)),
            dimensions: dim,
        })
    }

    /// Save index to disk (atomic write)
    #[napi]
    pub fn save(&self, index_path: String) -> Result<()> {
        let guard = self.inner.read();
        index::save_index(&guard, &index_path).map_err(|e| Error::from_reason(e))
    }

    /// Add a single vector
    #[napi]
    pub fn add(&self, id: u32, vector: Buffer) -> Result<()> {
        let vec_f32 = buffer_to_f32_slice(&vector)?;
        self.check_dimensions(vec_f32.len())?;

        let guard = self.inner.write();
        index::add_vector(&guard, id as u64, &vec_f32).map_err(|e| Error::from_reason(e))
    }

    /// Add vectors in batch
    #[napi]
    pub fn add_batch(&self, ids: Vec<u32>, vectors: Buffer) -> Result<()> {
        let vec_f32 = buffer_to_f32_slice(&vectors)?;
        let ids_u64: Vec<u64> = ids.iter().map(|&id| id as u64).collect();

        let guard = self.inner.write();
        index::add_vectors_batch(&guard, &ids_u64, &vec_f32, self.dimensions as usize)
            .map_err(|e| Error::from_reason(e))
    }

    /// Search for nearest neighbors
    #[napi]
    pub fn search(&self, query: Buffer, k: u32) -> Result<Vec<SearchResult>> {
        let query_f32 = buffer_to_f32_slice(&query)?;
        self.check_dimensions(query_f32.len())?;

        let guard = self.inner.read();
        index::search_vectors(&guard, &query_f32, k as usize)
            .map_err(|e| Error::from_reason(e))
    }

    /// Remove a vector by id
    #[napi]
    pub fn remove(&self, id: u32) -> Result<()> {
        let guard = self.inner.write();
        index::remove_vector(&guard, id as u64).map_err(|e| Error::from_reason(e))
    }

    /// Get index statistics
    #[napi]
    pub fn stats(&self) -> AnchorStats {
        let guard = self.inner.read();
        index::get_stats(&guard, self.dimensions)
    }

    /// Initialize SQLite database schema at the given path
    #[napi]
    pub fn init_database(db_path: String) -> Result<()> {
        let conn = rusqlite::Connection::open(&db_path)
            .map_err(|e| Error::from_reason(format!("Failed to open database: {}", e)))?;
        storage::init_schema(&conn)
            .map_err(|e| Error::from_reason(format!("Failed to init schema: {}", e)))
    }

    // -- Helper methods --

    fn check_dimensions(&self, vec_len: usize) -> Result<()> {
        if vec_len != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Dimension mismatch: expected {}, got {}",
                self.dimensions, vec_len
            )));
        }
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // Math operations (Phase 2A)
    // ═══════════════════════════════════════════════════════════════════

    /// Compute SVD on a matrix of N row vectors.
    /// `vectors`: N×dim flattened Buffer (f32), `n`: row count, `max_k`: max components
    #[napi]
    pub fn compute_svd(&self, vectors: Buffer, n: u32, max_k: u32) -> Result<types::SvdResult> {
        let vecs_f32 = buffer_to_f32_slice(&vectors)?;
        math::compute_svd(&vecs_f32, n as usize, self.dimensions as usize, max_k as usize)
            .map_err(|e| Error::from_reason(e))
    }

    /// Gram-Schmidt orthogonal projection of a vector onto tag basis vectors.
    /// `vector`: dim-length Buffer, `tags`: n_tags×dim flattened Buffer, `n_tags`: tag count
    #[napi]
    pub fn compute_orthogonal_projection(
        &self,
        vector: Buffer,
        tags: Buffer,
        n_tags: u32,
    ) -> Result<types::ProjectionResult> {
        let vec_f32 = buffer_to_f32_slice(&vector)?;
        self.check_dimensions(vec_f32.len())?;
        let tags_f32 = buffer_to_f32_slice(&tags)?;
        math::compute_orthogonal_projection(&vec_f32, &tags_f32, n_tags as usize)
            .map_err(|e| Error::from_reason(e))
    }

    /// EPA: project vector onto SVD basis, analyze energy distribution.
    /// `vector`: dim-length, `basis`: k×dim, `mean`: dim-length (centering), `k`: component count
    #[napi]
    pub fn project(
        &self,
        vector: Buffer,
        basis: Buffer,
        mean: Buffer,
        k: u32,
    ) -> Result<types::EpaResult> {
        let vec_f32 = buffer_to_f32_slice(&vector)?;
        self.check_dimensions(vec_f32.len())?;
        let basis_f32 = buffer_to_f32_slice(&basis)?;
        let mean_f32 = buffer_to_f32_slice(&mean)?;
        math::project_epa(&vec_f32, &basis_f32, &mean_f32, k as usize)
            .map_err(|e| Error::from_reason(e))
    }

    /// Expand seed tags by 1-hop cooccurrence.
    /// Returns Vec<{tagId, weight, source}> sorted by weight descending.
    #[napi]
    pub fn expand_tags(
        &self,
        seed_ids: Vec<u32>,
        cooc_tag_a: Vec<u32>,
        cooc_tag_b: Vec<u32>,
        cooc_weights: Vec<f64>,
        top_n: u32,
        min_weight: f64,
    ) -> Vec<types::TagExpansionResult> {
        math::expand_tags_1hop(
            &seed_ids, &cooc_tag_a, &cooc_tag_b, &cooc_weights,
            top_n as usize, min_weight,
        )
        .into_iter()
        .map(|e| types::TagExpansionResult {
            tag_id: e.tag_id,
            weight: e.weight,
            source: e.source,
        })
        .collect()
    }

    /// Compute cosine similarity between two vectors (f32 Buffers)
    #[napi]
    pub fn cosine_similarity(&self, a: Buffer, b: Buffer) -> Result<f64> {
        let a_f32 = buffer_to_f32_slice(&a)?;
        let b_f32 = buffer_to_f32_slice(&b)?;
        Ok(math::cosine_similarity(&a_f32, &b_f32))
    }
}

/// Convert a Node.js Buffer (raw bytes) to a Vec<f32>
fn buffer_to_f32_slice(buf: &Buffer) -> Result<Vec<f32>> {
    let bytes: &[u8] = buf.as_ref();
    if bytes.len() % 4 != 0 {
        return Err(Error::from_reason(format!(
            "Buffer length {} is not a multiple of 4 (f32 size)",
            bytes.len()
        )));
    }

    let floats: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();

    Ok(floats)
}
