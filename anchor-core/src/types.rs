// anchor-core/src/types.rs
// Shared data types for N-API export

use napi_derive::napi;

/// Vector search result
#[napi(object)]
#[derive(Debug, Clone)]
pub struct SearchResult {
    /// SQLite row ID
    pub id: u32,
    /// Similarity score (0-1, higher = more similar)
    pub score: f64,
}

/// Index statistics
#[napi(object)]
#[derive(Debug, Clone)]
pub struct AnchorStats {
    /// Total indexed vectors
    pub total_vectors: u32,
    /// Vector dimensions
    pub dimensions: u32,
    /// Current capacity
    pub capacity: u32,
    /// Memory usage in bytes
    pub memory_usage: u32,
}

/// SVD decomposition result (Phase 2)
#[napi(object)]
#[derive(Debug, Clone)]
pub struct SvdResult {
    /// Orthogonal basis vectors (k × dim, flattened)
    pub u: Vec<f64>,
    /// Singular values
    pub s: Vec<f64>,
    /// Number of retained components
    pub k: u32,
    /// Vector dimension
    pub dim: u32,
}

/// Gram-Schmidt orthogonal projection result (Phase 2)
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ProjectionResult {
    /// Projection vector
    pub projection: Vec<f64>,
    /// Residual vector
    pub residual: Vec<f64>,
    /// Basis coefficients for each tag
    pub basis_coefficients: Vec<f64>,
}

/// EPA projection result (Phase 2)
#[napi(object)]
#[derive(Debug, Clone)]
pub struct EpaResult {
    /// Projection values on each principal component
    pub projections: Vec<f64>,
    /// Energy distribution probabilities
    pub probabilities: Vec<f64>,
    /// Projection entropy
    pub entropy: f64,
    /// Total energy
    pub total_energy: f64,
}

/// Tag cooccurrence expansion result
#[napi(object)]
#[derive(Debug, Clone)]
pub struct TagExpansionResult {
    /// Expanded tag ID
    pub tag_id: u32,
    /// Cooccurrence weight
    pub weight: f64,
    /// Which seed tag caused this expansion
    pub source: u32,
}
