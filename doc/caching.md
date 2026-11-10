# Cache behavior

## Two-Stage Cache

The plugin uses two layers of caching:

| Cache | Key | Value | Managed By |
| --- | --- | --- | --- |
| **Dependency List** | Task (`<project root>:<target>`) | Set of observed file access queries | `nx-auto-cache-deps` |
| **Execution Result** | Nx task hash (includes dependency list hash) | Artifact outputs and logs | Nx |

1. When Nx computes a task hash, `nx-auto-cache-deps` looks for an existing dependency list for the task.
2. **If no dependency list exists**: The plugin returns a different value each time. This guarantees a cache miss in Nx, forcing the command to run.
3. **If a dependency list exists**: The plugin evaluates the recorded dependencies against the current filesystem and returns their hash. Nx includes this hash in the task hash and queries its cache, restoring existing outputs on a cache hit.
4. When the command executes, fspy traces the process tree. Upon successful completion, the observed dependencies are saved to the dependency list.

> **Note on Initial Cache Hits**: The result of a run executed without a dependency list is saved under a key that does not include dependency hashes and is not reused. The subsequent run computes a hash from the newly saved dependency list, executes, and caches its outputs under that hash. The first cache restore can occur on the **3rd run**. If later runs discover additional dependencies (for example, Windows shell commands can list additional directories once outputs exist), the dependency list expands and another execution is needed to cache results under the updated hash. Cache restoration starts once that list stabilizes.

## What Is Tracked

The tracer monitors the entire process tree (including child processes and native tools) using fspy:

- **File reads**: Detects content modifications, deletions, or replacement by directories.
- **Directory listings**: Detects additions, deletions, renames, or type changes of entries within listed directories (allowing detection of newly added files matching glob searches).
- **Probes of missing paths**: Detects when previously non-existent paths are created.

## What Is Excluded

The following paths are excluded when recording dependencies:

- **Paths outside the workspace**: System files, Node.js binary, etc., are ignored.
- **Paths written by the task**: Prevents generated outputs from being treated as task inputs.
- **Target `outputs` and parent directories**: Output artifact paths and parent directory probes are not recorded, and directory listings ignore entries leading to outputs. Artifacts are restored by Nx, so removing them is not treated as an input change.
- **Nx and Git metadata**: `.nx/` and `.git` are excluded (matching Nx's own task hashing behavior).

## Worktree Sharing

Dependency lists are saved under `nx-auto-cache-deps/` inside Nx's cache directory (`~/.nx/<id>/cache` in Nx 24). Because paths are stored relative to the workspace root, dependency lists are shared across git worktrees for the same workspace. Running `nx reset` clears the dependency lists along with Nx's cache.
