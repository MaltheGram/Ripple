export interface GlUser {
  id: number;
  username: string;
  name: string;
  avatar_url?: string;
}

export interface GlProject {
  id: number;
  path_with_namespace: string;
  http_url_to_repo: string;
  web_url: string;
}

export interface GlDiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

export interface GlMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  diff_refs: GlDiffRefs;
  author: GlUser;
  references?: { full: string };
  draft?: boolean;
  updated_at?: string;
  user_notes_count?: number;
}

export interface GlGroup {
  id: number;
  full_path: string;
  name: string;
}

export interface GlPosition extends Partial<GlDiffRefs> {
  position_type: 'text' | 'image' | 'file';
  old_path?: string;
  new_path?: string;
  old_line?: number | null;
  new_line?: number | null;
  line_range?: {
    start: { line_code: string; type?: 'new' | 'old' | null; old_line?: number | null; new_line?: number | null };
    end: { line_code: string; type?: 'new' | 'old' | null; old_line?: number | null; new_line?: number | null };
  } | null;
}

export interface GlNote {
  id: number;
  body: string;
  author: GlUser;
  created_at: string;
  system: boolean;
  resolvable: boolean;
  resolved?: boolean;
  position?: GlPosition;
}

export interface GlDiscussion {
  id: string;
  individual_note: boolean;
  notes: GlNote[];
}

export interface GlDraftNote {
  id: number;
  note: string;
  discussion_id?: string | null;
  position?: GlPosition | null;
}

export interface GlApprovals {
  approved: boolean;
  approved_by: { user: GlUser }[];
}

/** Advanced Search blob hit (`scope=blobs`). */
export interface GlBlob {
  basename: string;
  data: string;
  path: string;
  filename: string;
  ref: string;
  startline: number;
  project_id: number;
}

export interface GlApprovalRule {
  id: number;
  name: string;
  rule_type: string;
  approvals_required: number;
  approved: boolean;
  approved_by: GlUser[];
  eligible_approvers: GlUser[];
  code_owner?: boolean;
  section?: string | null;
}

export interface GlApprovalState {
  rules: GlApprovalRule[];
}

export interface GlPipeline {
  id: number;
  sha: string;
  status: string;
  web_url: string;
  created_at?: string;
}

export interface GlJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  web_url: string;
  artifacts?: { file_type: string; filename: string }[];
}

export interface GlMrVersion {
  id: number;
  head_commit_sha: string;
  base_commit_sha: string;
  start_commit_sha: string;
  created_at: string;
}

export interface GlBlameRange {
  commit: { id: string; message: string; author_name: string; authored_date: string };
  lines: string[];
}

export interface GlGroupRef {
  id: number;
  full_path: string;
}
