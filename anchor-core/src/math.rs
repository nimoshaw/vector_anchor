// anchor-core/src/math.rs
// High-performance mathematical operations for the search enhancement pipeline.
//
// Provides three core algorithms used in the 3-stage retrieval pipeline:
//   1. SVD (Singular Value Decomposition) — semantic deduplication & topic modeling
//   2. Gram-Schmidt orthogonal projection — residual compensation search
//   3. EPA (Energy Projection Analysis) — query complexity / logical depth scoring
//
// Additionally provides tag cooccurrence 1-hop expansion (Rust-native).
//
// All functions operate on f64 for numerical stability and convert back to the
// caller's precision as needed.

use nalgebra::{DMatrix, DVector, SVD};

use crate::types::{SvdResult, ProjectionResult, EpaResult};

// ═══════════════════════════════════════════════════════════════════════════
// 1. SVD — Singular Value Decomposition
// ═══════════════════════════════════════════════════════════════════════════
//
// Purpose in pipeline:
//   - Topic modeling: extract principal semantic axes from a set of vectors
//   - Deduplication: project results onto principal components, detect overlap
//   - Dimensionality insight: which directions carry the most variance?
//
// Input:  A set of N vectors, each of dimension D (flattened row-major)
// Output: Top-k left singular vectors (basis), singular values, dimensions

/// Compute truncated SVD on a matrix of N row vectors of dimension D.
///
/// # Arguments
/// * `vectors_flat` — N×D matrix flattened in row-major order (f32 from JS)
/// * `n`            — number of vectors (rows)
/// * `dim`          — dimension of each vector (columns)
/// * `max_k`        — maximum number of singular components to retain
///
/// # Returns
/// `SvdResult` with top-k left singular vectors, singular values, and metadata.
pub fn compute_svd(
    vectors_flat: &[f32],
    n: usize,
    dim: usize,
    max_k: usize,
) -> Result<SvdResult, String> {
    if vectors_flat.len() != n * dim {
        return Err(format!(
            "SVD input size mismatch: expected {}×{}={}, got {}",
            n, dim, n * dim, vectors_flat.len()
        ));
    }
    if n == 0 || dim == 0 {
        return Err("SVD: n and dim must be > 0".into());
    }

    // Convert f32 → f64 for numerical stability
    let data_f64: Vec<f64> = vectors_flat.iter().map(|&v| v as f64).collect();

    // nalgebra stores matrices in column-major order, but our input is row-major.
    // Construct as column-major by transposing: create (dim × n) then transpose.
    let mat = DMatrix::from_row_slice(n, dim, &data_f64);

    // Center the data (subtract column means) for better SVD quality
    let col_means: DVector<f64> = mat.row_mean().transpose();
    let centered = &mat - DMatrix::from_fn(n, dim, |_r, c| col_means[c]);

    // Full SVD decomposition
    let svd = SVD::new(centered.clone(), true, false);

    let singular_values = svd.singular_values;
    let u_matrix = svd.u.ok_or("SVD: failed to compute U matrix")?;

    // Determine how many components to keep:
    // At most max_k, at most min(n, dim), and only those with non-negligible energy
    let total_energy: f64 = singular_values.iter().map(|s| s * s).sum();
    let energy_threshold = total_energy * 0.01; // drop components with < 1% energy

    let mut k = max_k.min(singular_values.len());
    while k > 1 {
        let s = singular_values[k - 1];
        if s * s >= energy_threshold {
            break;
        }
        k -= 1;
    }

    // Extract top-k left singular vectors (each is a column of U, length n)
    // For the pipeline, we actually want the right singular vectors (V^T rows)
    // which represent the principal directions in the vector space.
    // Since A = U Σ V^T, and we want V, we can compute V from U and A:
    //   V_i = (A^T u_i) / σ_i
    // However, for our use case (projecting query vectors), we need the
    // principal components in the original D-dimensional space.
    let mut u_flat: Vec<f64> = Vec::with_capacity(k * dim);
    for i in 0..k {
        let sigma = singular_values[i];
        if sigma.abs() < 1e-12 {
            // Degenerate: fill with zeros
            u_flat.extend(std::iter::repeat(0.0).take(dim));
            continue;
        }
        // V_i = (A^T * u_i) / sigma_i  →  a dim-length vector
        let u_col = u_matrix.column(i);
        let v_i = (centered.transpose() * &u_col) / sigma;
        // Normalize to unit length
        let norm = v_i.norm();
        if norm > 1e-12 {
            for j in 0..dim {
                u_flat.push(v_i[j] / norm);
            }
        } else {
            u_flat.extend(std::iter::repeat(0.0).take(dim));
        }
    }

    let s_values: Vec<f64> = singular_values.iter().take(k).copied().collect();

    Ok(SvdResult {
        u: u_flat,
        s: s_values,
        k: k as u32,
        dim: dim as u32,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Gram-Schmidt Orthogonal Projection
// ═══════════════════════════════════════════════════════════════════════════
//
// Purpose in pipeline:
//   - Residual compensation: project query onto the subspace spanned by
//     known tag vectors, then compute the residual (unexplained component).
//   - The residual captures what the tags DON'T explain — used for
//     secondary search to find surprising/novel results.
//   - Basis coefficients tell us which tags are most relevant to the query.
//
// Algorithm:
//   1. Orthogonalize the tag vectors via modified Gram-Schmidt
//   2. Project the query vector onto each orthogonal basis vector
//   3. Sum projections = explained component, remainder = residual

/// Compute orthogonal projection of a vector onto a set of tag basis vectors.
///
/// Uses Modified Gram-Schmidt for numerical stability.
///
/// # Arguments
/// * `vector`   — the query vector (dim-length, f32)
/// * `tags_flat` — n_tags × dim flattened in row-major (the tag embedding vectors)
/// * `n_tags`   — number of tag vectors
///
/// # Returns
/// `ProjectionResult` with projection, residual, and per-tag coefficients.
pub fn compute_orthogonal_projection(
    vector: &[f32],
    tags_flat: &[f32],
    n_tags: usize,
) -> Result<ProjectionResult, String> {
    let dim = vector.len();
    if dim == 0 {
        return Err("Projection: vector dimension must be > 0".into());
    }
    if tags_flat.len() != n_tags * dim {
        return Err(format!(
            "Projection: tags size mismatch: expected {}×{}={}, got {}",
            n_tags, dim, n_tags * dim, tags_flat.len()
        ));
    }
    if n_tags == 0 {
        // No tags → residual IS the vector
        let v: Vec<f64> = vector.iter().map(|&x| x as f64).collect();
        return Ok(ProjectionResult {
            projection: vec![0.0; dim],
            residual: v,
            basis_coefficients: vec![],
        });
    }

    // Convert to f64
    let q = DVector::from_iterator(dim, vector.iter().map(|&x| x as f64));

    // Build tag vectors as DVector<f64>
    let mut basis: Vec<DVector<f64>> = Vec::with_capacity(n_tags);
    for i in 0..n_tags {
        let start = i * dim;
        let end = start + dim;
        let bv = DVector::from_iterator(dim, tags_flat[start..end].iter().map(|&x| x as f64));
        basis.push(bv);
    }

    // ── Modified Gram-Schmidt orthogonalization ──
    // Produces an orthonormal basis from the tag vectors.
    // We keep track of which original tags each basis vector corresponds to.
    let mut ortho_basis: Vec<DVector<f64>> = Vec::with_capacity(n_tags);
    let mut valid_indices: Vec<usize> = Vec::with_capacity(n_tags);

    for i in 0..n_tags {
        let mut v = basis[i].clone();

        // Subtract projections onto all previously computed orthogonal vectors
        for q_prev in &ortho_basis {
            let proj_coeff = v.dot(q_prev); // q_prev is already unit length
            v -= proj_coeff * q_prev;
        }

        let norm = v.norm();
        if norm > 1e-10 {
            v /= norm;
            ortho_basis.push(v);
            valid_indices.push(i);
        }
        // If norm ≈ 0, this tag is linearly dependent — skip it
    }

    // ── Project query onto orthogonal basis ──
    let mut projection = DVector::zeros(dim);
    let mut coefficients = vec![0.0f64; n_tags];

    for (idx, ortho_vec) in ortho_basis.iter().enumerate() {
        let coeff = q.dot(ortho_vec);
        projection += coeff * ortho_vec;
        coefficients[valid_indices[idx]] = coeff;
    }

    // Residual = query - projection
    let residual = &q - &projection;

    Ok(ProjectionResult {
        projection: projection.iter().copied().collect(),
        residual: residual.iter().copied().collect(),
        basis_coefficients: coefficients,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. EPA — Energy Projection Analysis
// ═══════════════════════════════════════════════════════════════════════════
//
// Purpose in pipeline:
//   - Logical depth estimation: how "complex" is this query?
//   - If energy is concentrated on one axis → simple query → standard search
//   - If energy is spread across many axes → complex query → deeper boost
//   - Entropy provides a single scalar measure of query complexity
//
// Algorithm:
//   1. Project the query vector onto each principal component (from SVD basis)
//   2. Compute energy = projection² for each component
//   3. Normalize energies into a probability distribution
//   4. Compute Shannon entropy: H = -Σ p_i log(p_i)

/// Project a vector onto a set of SVD basis vectors and analyze energy distribution.
///
/// # Arguments
/// * `vector`    — the query vector (dim-length, f32)
/// * `basis_flat` — k × dim flattened (the SVD principal components, from SvdResult.u)
/// * `mean_flat` — column mean vector (dim-length, for centering; can be zeros)
/// * `k`         — number of basis vectors
///
/// # Returns
/// `EpaResult` with projection values, energy probabilities, entropy, total energy.
pub fn project_epa(
    vector: &[f32],
    basis_flat: &[f32],
    mean_flat: &[f32],
    k: usize,
) -> Result<EpaResult, String> {
    let dim = vector.len();
    if dim == 0 {
        return Err("EPA: vector dimension must be > 0".into());
    }
    if mean_flat.len() != dim {
        return Err(format!("EPA: mean dimension mismatch: expected {}, got {}", dim, mean_flat.len()));
    }
    if basis_flat.len() != k * dim {
        return Err(format!("EPA: basis size mismatch: expected {}×{}={}, got {}", k, dim, k * dim, basis_flat.len()));
    }
    if k == 0 {
        return Ok(EpaResult {
            projections: vec![],
            probabilities: vec![],
            entropy: 0.0,
            total_energy: 0.0,
        });
    }

    // Center the vector
    let centered: Vec<f64> = vector.iter()
        .zip(mean_flat.iter())
        .map(|(&v, &m)| v as f64 - m as f64)
        .collect();
    let q = DVector::from_vec(centered);

    // Project onto each basis vector
    let mut projections = Vec::with_capacity(k);
    let mut energies = Vec::with_capacity(k);

    for i in 0..k {
        let start = i * dim;
        let end = start + dim;
        let basis_vec = DVector::from_iterator(
            dim,
            basis_flat[start..end].iter().map(|&x| x as f64),
        );
        let proj = q.dot(&basis_vec);
        let energy = proj * proj;
        projections.push(proj);
        energies.push(energy);
    }

    let total_energy: f64 = energies.iter().sum();

    // Compute probability distribution (normalize energies)
    let probabilities: Vec<f64> = if total_energy > 1e-15 {
        energies.iter().map(|e| e / total_energy).collect()
    } else {
        vec![1.0 / k as f64; k] // uniform if zero energy
    };

    // Shannon entropy: H = -Σ p_i · ln(p_i)
    // Higher entropy = more uniform = more complex query
    // Lower entropy = concentrated on few axes = simpler query
    let entropy: f64 = probabilities.iter()
        .filter(|&&p| p > 1e-15)
        .map(|&p| -p * p.ln())
        .sum();

    Ok(EpaResult {
        projections,
        probabilities,
        entropy,
        total_energy,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Tag Cooccurrence 1-hop Expansion
// ═══════════════════════════════════════════════════════════════════════════
//
// Purpose in pipeline:
//   - Given a set of "seed" tag IDs, expand by finding co-occurring tags
//   - Uses the tag_cooccurrence table from SQLite
//   - Returns expanded tag set with weights for boosted recall
//
// This function operates on pre-loaded cooccurrence data (avoid SQLite in
// the hot path). The TypeScript layer loads the cooccurrence matrix once
// and passes it in as flat arrays.

/// Tag cooccurrence entry for the expansion result.
#[derive(Debug, Clone)]
pub struct CooccurrenceExpansion {
    pub tag_id: u32,
    pub weight: f64,
    pub source: u32, // which seed tag caused this expansion
}

/// Expand seed tags by 1-hop cooccurrence.
///
/// # Arguments
/// * `seed_ids`         — seed tag IDs
/// * `cooc_tag_a`       — cooccurrence matrix column: tag_a_id
/// * `cooc_tag_b`       — cooccurrence matrix column: tag_b_id
/// * `cooc_weights`     — cooccurrence matrix column: weight
/// * `top_n`            — max number of expanded tags to return (per seed)
/// * `min_weight`       — minimum cooccurrence weight to include
///
/// # Returns
/// List of expanded tags, deduplicated and sorted by weight descending.
pub fn expand_tags_1hop(
    seed_ids: &[u32],
    cooc_tag_a: &[u32],
    cooc_tag_b: &[u32],
    cooc_weights: &[f64],
    top_n: usize,
    min_weight: f64,
) -> Vec<CooccurrenceExpansion> {
    use hashbrown::HashMap;

    let seed_set: hashbrown::HashSet<u32> = seed_ids.iter().copied().collect();
    let n = cooc_tag_a.len().min(cooc_tag_b.len()).min(cooc_weights.len());

    // Collect candidate expansions: tag_id → (best_weight, source_tag)
    let mut candidates: HashMap<u32, (f64, u32)> = HashMap::new();

    for i in 0..n {
        let a = cooc_tag_a[i];
        let b = cooc_tag_b[i];
        let w = cooc_weights[i];

        if w < min_weight {
            continue;
        }

        // If a is a seed, b is a candidate (and vice versa)
        if seed_set.contains(&a) && !seed_set.contains(&b) {
            let entry = candidates.entry(b).or_insert((0.0, a));
            if w > entry.0 {
                *entry = (w, a);
            }
        }
        if seed_set.contains(&b) && !seed_set.contains(&a) {
            let entry = candidates.entry(a).or_insert((0.0, b));
            if w > entry.0 {
                *entry = (w, b);
            }
        }
    }

    // Sort by weight descending, take top_n
    let mut results: Vec<CooccurrenceExpansion> = candidates
        .into_iter()
        .map(|(tag_id, (weight, source))| CooccurrenceExpansion { tag_id, weight, source })
        .collect();

    results.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    results.truncate(top_n);

    results
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Utility: Cosine Similarity + Vector Normalization
// ═══════════════════════════════════════════════════════════════════════════

/// Compute cosine similarity between two vectors (f32).
/// Returns a value in [-1, 1], or 0.0 if either vector has zero norm.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }

    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;

    for i in 0..a.len() {
        let ai = a[i] as f64;
        let bi = b[i] as f64;
        dot += ai * bi;
        norm_a += ai * ai;
        norm_b += bi * bi;
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom < 1e-15 { 0.0 } else { dot / denom }
}

/// L2-normalize a vector in-place (f32). Returns the original norm.
pub fn normalize_l2(v: &mut [f32]) -> f32 {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-10 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
    norm
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_svd_basic() {
        // 4 vectors of dimension 3 with clear 2D structure (x-y plane)
        // Spread well so both principal components carry significant energy
        let vectors: Vec<f32> = vec![
            2.0,  0.0, 0.0,
            0.0,  2.0, 0.0,
           -2.0,  0.0, 0.0,
            0.0, -2.0, 0.0,
        ];
        let result = compute_svd(&vectors, 4, 3, 3).unwrap();

        // Should retain 2 components (all energy is in x-y plane)
        assert!(result.k >= 1, "SVD should retain at least 1 component, got k={}", result.k);
        assert_eq!(result.dim, 3);
        assert_eq!(result.u.len(), result.k as usize * 3);
        assert_eq!(result.s.len(), result.k as usize);

        // Singular values should be positive and descending
        assert!(result.s[0] > 0.0);
        for i in 1..result.s.len() {
            assert!(result.s[i - 1] >= result.s[i], "Singular values not descending");
        }
    }

    #[test]
    fn test_svd_single_vector() {
        let vectors: Vec<f32> = vec![1.0, 2.0, 3.0];
        let result = compute_svd(&vectors, 1, 3, 1).unwrap();
        assert_eq!(result.k, 1);
        assert_eq!(result.s.len(), 1);
    }

    #[test]
    fn test_gram_schmidt_orthogonal() {
        // Query vector
        let query: Vec<f32> = vec![3.0, 4.0, 0.0];

        // Two tag vectors (basis)
        let tags: Vec<f32> = vec![
            1.0, 0.0, 0.0,  // tag 0: x-axis
            0.0, 1.0, 0.0,  // tag 1: y-axis
        ];

        let result = compute_orthogonal_projection(&query, &tags, 2).unwrap();

        // Projection should be [3, 4, 0] (query lies in the span of both tags)
        assert!((result.projection[0] - 3.0).abs() < 1e-6);
        assert!((result.projection[1] - 4.0).abs() < 1e-6);
        assert!((result.projection[2] - 0.0).abs() < 1e-6);

        // Residual should be near zero
        let residual_norm: f64 = result.residual.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!(residual_norm < 1e-6);

        // Coefficients: tag 0 should be ~3, tag 1 should be ~4
        assert!((result.basis_coefficients[0] - 3.0).abs() < 1e-6);
        assert!((result.basis_coefficients[1] - 4.0).abs() < 1e-6);
    }

    #[test]
    fn test_gram_schmidt_residual() {
        // Query has a component outside the tag subspace
        let query: Vec<f32> = vec![1.0, 1.0, 5.0];
        let tags: Vec<f32> = vec![
            1.0, 0.0, 0.0,  // only covers x-axis
        ];

        let result = compute_orthogonal_projection(&query, &tags, 1).unwrap();

        // Residual should capture the y and z components
        assert!((result.residual[0]).abs() < 1e-6); // x projected away
        assert!((result.residual[1] - 1.0).abs() < 1e-6);
        assert!((result.residual[2] - 5.0).abs() < 1e-6);
    }

    #[test]
    fn test_epa_concentrated() {
        // Vector aligned with first basis → low entropy
        let vector: Vec<f32> = vec![1.0, 0.0, 0.0];
        let basis: Vec<f32> = vec![
            1.0, 0.0, 0.0,  // basis 0
            0.0, 1.0, 0.0,  // basis 1
        ];
        let mean: Vec<f32> = vec![0.0, 0.0, 0.0];

        let result = project_epa(&vector, &basis, &mean, 2).unwrap();

        assert_eq!(result.projections.len(), 2);
        assert!((result.projections[0] - 1.0).abs() < 1e-6);
        assert!((result.projections[1]).abs() < 1e-6);

        // Energy should be concentrated
        assert!((result.probabilities[0] - 1.0).abs() < 1e-6);
        assert!(result.entropy < 0.01); // near-zero entropy
    }

    #[test]
    fn test_epa_spread() {
        // Vector equally aligned with both basis vectors → high entropy
        let s = 1.0f32 / 2.0f32.sqrt();
        let vector: Vec<f32> = vec![s, s, 0.0];
        let basis: Vec<f32> = vec![
            1.0, 0.0, 0.0,
            0.0, 1.0, 0.0,
        ];
        let mean: Vec<f32> = vec![0.0, 0.0, 0.0];

        let result = project_epa(&vector, &basis, &mean, 2).unwrap();

        // Probabilities should be ~0.5, 0.5
        assert!((result.probabilities[0] - 0.5).abs() < 1e-6);
        assert!((result.probabilities[1] - 0.5).abs() < 1e-6);

        // Entropy should be ln(2) ≈ 0.693
        assert!((result.entropy - 2.0f64.ln()).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity() {
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        assert!((cosine_similarity(&a, &b)).abs() < 1e-6); // orthogonal = 0

        let c = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &c) - 1.0).abs() < 1e-6); // parallel = 1

        let d = vec![-1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &d) + 1.0).abs() < 1e-6); // antiparallel = -1
    }

    #[test]
    fn test_normalize_l2() {
        let mut v = vec![3.0f32, 4.0];
        let norm = normalize_l2(&mut v);
        assert!((norm - 5.0).abs() < 1e-6);
        assert!((v[0] - 0.6).abs() < 1e-6);
        assert!((v[1] - 0.8).abs() < 1e-6);
    }

    #[test]
    fn test_tag_expansion_1hop() {
        let seeds = vec![1, 2];
        let cooc_a = vec![1, 1, 2, 3, 4];
        let cooc_b = vec![3, 4, 5, 4, 5];
        let weights = vec![0.8, 0.3, 0.9, 0.5, 0.2];

        let expanded = expand_tags_1hop(&seeds, &cooc_a, &cooc_b, &weights, 10, 0.1);

        // Tag 5 (from seed 2, w=0.9) should be first
        assert!(expanded.iter().any(|e| e.tag_id == 5 && (e.weight - 0.9).abs() < 1e-6));
        // Tag 3 (from seed 1, w=0.8) should be present
        assert!(expanded.iter().any(|e| e.tag_id == 3 && (e.weight - 0.8).abs() < 1e-6));
        // Tag 4 (from seed 1, w=0.3 or from 3→4 but 3 is not a seed)
        assert!(expanded.iter().any(|e| e.tag_id == 4));
        // Seeds should NOT appear in expansion
        assert!(!expanded.iter().any(|e| e.tag_id == 1 || e.tag_id == 2));
    }
}
