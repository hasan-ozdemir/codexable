use hex;
use sha2::Digest;
use sha2::Sha256;
use std::path::Path;

/// Normalize a cwd string/path for comparison and slugging.
pub fn normalize_cwd_path(p: &Path) -> String {
    let canonical = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    canonical
        .to_string_lossy()
        .to_string()
        .replace('\\', "/")
        .trim_start_matches("//?/")
        .trim_start_matches("\\\\?\\")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

/// Compute a deterministic slug for a cwd.
/// Combines a hash of the normalized path with the sanitized tail segment.
pub fn slug_for_cwd(cwd: &Path) -> String {
    let norm = normalize_cwd_path(cwd);

    let mut hasher = Sha256::new();
    hasher.update(norm.as_bytes());
    let digest = hasher.finalize();
    let hash_prefix = &digest[..8]; // 8 bytes -> 16 hex chars
    let hash = hex::encode(hash_prefix);

    let tail = cwd.file_name().and_then(|s| s.to_str()).unwrap_or("root");
    let tail = sanitize_component(tail);

    format!("{hash}-{tail}")
}

/// Case/sep‑insensitive path equality for cwd matching.
#[allow(dead_code)]
pub fn paths_match(a: &Path, b: &Path) -> bool {
    normalize_cwd_path(a) == normalize_cwd_path(b)
}

fn sanitize_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '@') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    let cleaned = if trimmed.is_empty() {
        "cwd".to_string()
    } else {
        trimmed.to_string()
    };
    cleaned.chars().take(48).collect()
}

/// Extract slug component from a rollout path: expects .../YYYY/MM/DD/<slug>/rollout-*.jsonl
pub fn slug_from_rollout_path(path: &Path) -> Option<String> {
    let parent = path.parent()?;
    let slug_os = parent.file_name()?;
    Some(slug_os.to_string_lossy().to_string())
}
