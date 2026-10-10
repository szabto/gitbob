import { useCallback } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DiffTarget } from '@shared/types'
import { call } from './api'

export const PAGE_SIZE = 2000

export function useRefs(repoPath: string) {
  return useQuery({ queryKey: ['refs', repoPath], queryFn: () => call('repo:refs', { repoPath }) })
}

export function useHead(repoPath: string) {
  return useQuery({ queryKey: ['head', repoPath], queryFn: () => call('repo:head', { repoPath }) })
}

export function useHistory(repoPath: string) {
  return useInfiniteQuery({
    queryKey: ['log', repoPath],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => call('log:page', { repoPath, skip: pageParam, limit: PAGE_SIZE }),
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE_SIZE : undefined),
  })
}

export function useCommitDetails(repoPath: string, sha: string | null) {
  return useQuery({
    queryKey: ['commit', repoPath, sha],
    queryFn: () => call('commit:details', { repoPath, sha: sha! }),
    enabled: !!sha,
    staleTime: Infinity,
  })
}

export function useRecent() {
  return useQuery({ queryKey: ['recent'], queryFn: () => call('repo:recent', {}) })
}

export function useStatus(repoPath: string) {
  return useQuery({ queryKey: ['status', repoPath], queryFn: () => call('status:get', { repoPath }), staleTime: 0 })
}

export function useFileDiff(repoPath: string, target: DiffTarget | null) {
  return useQuery({
    queryKey: ['diff', repoPath, target],
    queryFn: () => call('diff:file', { repoPath, target: target! }),
    enabled: !!target,
    // Commit diffs are immutable; working tree diffs must always be fresh.
    staleTime: target?.kind === 'commit' ? Infinity : 0,
  })
}

/** Invalidate everything that depends on the repository's on-disk state. */
export function useInvalidateRepo(repoPath: string) {
  const qc = useQueryClient()
  return useCallback(
    (opts: { history?: boolean } = {}) => {
      void qc.invalidateQueries({ queryKey: ['status', repoPath] })
      void qc.invalidateQueries({ queryKey: ['diff', repoPath] })
      void qc.invalidateQueries({ queryKey: ['contents', repoPath] })
      void qc.invalidateQueries({ queryKey: ['head', repoPath] })
      void qc.invalidateQueries({ queryKey: ['refs', repoPath] })
      void qc.invalidateQueries({ queryKey: ['remotes', repoPath] })
      void qc.invalidateQueries({ queryKey: ['stashes', repoPath] })
      if (opts.history !== false) {
        void qc.invalidateQueries({ queryKey: ['log', repoPath] })
        void qc.invalidateQueries({ queryKey: ['search', repoPath] })
      }
    },
    [qc, repoPath],
  )
}

/** Mutation wrapper that refreshes repository state when it settles. */
export function useRepoMutation<TVars, TData>(
  repoPath: string,
  fn: (vars: TVars) => Promise<TData>,
  opts: { history?: boolean } = {},
) {
  const invalidate = useInvalidateRepo(repoPath)
  return useMutation({ mutationFn: fn, onSettled: () => invalidate(opts) })
}

export function useRemotes(repoPath: string) {
  return useQuery({ queryKey: ['remotes', repoPath], queryFn: () => call('remote:list', { repoPath }) })
}

export function useHistorySearch(repoPath: string, query: string) {
  return useQuery({
    queryKey: ['search', repoPath, query],
    queryFn: () => call('log:search', { repoPath, query }),
    enabled: query.trim().length > 0,
    placeholderData: (prev) => prev,
  })
}

export function useStashes(repoPath: string) {
  return useQuery({ queryKey: ['stashes', repoPath], queryFn: () => call('stash:list', { repoPath }) })
}

export function useStashFiles(repoPath: string, stash: { index: number; sha: string } | null) {
  return useQuery({
    queryKey: ['stash-files', repoPath, stash?.sha],
    queryFn: () => call('stash:files', { repoPath, index: stash!.index, sha: stash!.sha }),
    enabled: !!stash,
    staleTime: Infinity,
  })
}

export function useFileContents(repoPath: string, target: DiffTarget | null, enabled: boolean) {
  return useQuery({
    queryKey: ['contents', repoPath, target],
    queryFn: () => call('diff:contents', { repoPath, target: target! }),
    enabled: !!target && enabled,
    staleTime: target?.kind === 'commit' ? Infinity : 0,
  })
}
