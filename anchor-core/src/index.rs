// anchor-core/src/index.rs
// USearch HNSW vector index wrapper

use std::path::Path;
use usearch::{Index, IndexOptions, MetricKind, ScalarKind};

use crate::types::SearchResult;

/// Create a new USearch HNSW index
pub fn create_index(dimensions: usize, capacity: usize) -> Result<Index, String> {
    let options = IndexOptions {
        dimensions,
        metric: MetricKind::Cos,
        quantization: ScalarKind::F32,
        connectivity: 16,
        expansion_add: 128,
        expansion_search: 64,
        multi: false,
    };

    let index = Index::new(&options).map_err(|e| format!("Failed to create index: {}", e))?;
    index
        .reserve(capacity)
        .map_err(|e| format!("Failed to reserve capacity: {}", e))?;
    Ok(index)
}

/// Load an existing index from disk
pub fn load_index(
    path: &str,
    dimensions: usize,
    capacity: usize,
) -> Result<Index, String> {
    let index_path = Path::new(path);
    if !index_path.exists() {
        return Err(format!("Index file not found: {}", path));
    }

    let options = IndexOptions {
        dimensions,
        metric: MetricKind::Cos,
        quantization: ScalarKind::F32,
        connectivity: 16,
        expansion_add: 128,
        expansion_search: 64,
        multi: false,
    };

    let index = Index::new(&options).map_err(|e| format!("Failed to create index: {}", e))?;
    index
        .reserve(capacity)
        .map_err(|e| format!("Failed to reserve capacity: {}", e))?;
    index
        .load(path)
        .map_err(|e| format!("Failed to load index from {}: {}", path, e))?;
    Ok(index)
}

/// Save index to disk with atomic write (temp file + rename)
pub fn save_index(index: &Index, path: &str) -> Result<(), String> {
    let tmp_path = format!("{}.tmp", path);
    index
        .save(&tmp_path)
        .map_err(|e| format!("Failed to save index: {}", e))?;
    std::fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to rename temp file: {}", e))?;
    Ok(())
}

/// Add a single vector to the index
pub fn add_vector(index: &Index, id: u64, vector: &[f32]) -> Result<(), String> {
    // Auto-expand capacity if needed
    if index.size() + 1 >= index.capacity() {
        let new_capacity = (index.capacity() as f64 * 1.5) as usize;
        index
            .reserve(new_capacity)
            .map_err(|e| format!("Failed to expand capacity: {}", e))?;
    }

    index
        .add(id, vector)
        .map_err(|e| format!("Failed to add vector id={}: {}", id, e))?;
    Ok(())
}

/// Add vectors in batch
pub fn add_vectors_batch(
    index: &Index,
    ids: &[u64],
    vectors: &[f32],
    dimensions: usize,
) -> Result<(), String> {
    if vectors.len() != ids.len() * dimensions {
        return Err(format!(
            "Vector data size mismatch: expected {} * {} = {}, got {}",
            ids.len(),
            dimensions,
            ids.len() * dimensions,
            vectors.len()
        ));
    }

    // Auto-expand capacity if needed
    let needed = index.size() + ids.len();
    if needed >= index.capacity() {
        let new_capacity = (needed as f64 * 1.5) as usize;
        index
            .reserve(new_capacity)
            .map_err(|e| format!("Failed to expand capacity: {}", e))?;
    }

    for (i, &id) in ids.iter().enumerate() {
        let start = i * dimensions;
        let end = start + dimensions;
        let vec_slice = &vectors[start..end];
        index
            .add(id, vec_slice)
            .map_err(|e| format!("Failed to add vector id={}: {}", id, e))?;
    }
    Ok(())
}

/// Search for nearest neighbors
pub fn search_vectors(
    index: &Index,
    query: &[f32],
    k: usize,
) -> Result<Vec<SearchResult>, String> {
    if index.size() == 0 {
        return Ok(vec![]);
    }

    let actual_k = k.min(index.size());
    let matches = index
        .search(query, actual_k)
        .map_err(|e| format!("Search failed: {}", e))?;

    let results: Vec<SearchResult> = matches
        .keys
        .iter()
        .zip(matches.distances.iter())
        .map(|(&id, &distance)| {
            // Convert cosine distance to similarity score (0-1)
            let score = 1.0 - distance as f64;
            SearchResult {
                id: id as u32,
                score: score.max(0.0),
            }
        })
        .collect();

    Ok(results)
}

/// Remove a vector by id
pub fn remove_vector(index: &Index, id: u64) -> Result<(), String> {
    index
        .remove(id)
        .map_err(|e| format!("Failed to remove vector id={}: {}", id, e))?;
    Ok(())
}

/// Get index statistics
pub fn get_stats(index: &Index, dimensions: u32) -> crate::types::AnchorStats {
    crate::types::AnchorStats {
        total_vectors: index.size() as u32,
        dimensions,
        capacity: index.capacity() as u32,
        // Approximate memory: vectors * dim * 4 bytes (f32) + HNSW graph overhead
        memory_usage: (index.size() * dimensions as usize * 4) as u32,
    }
}
