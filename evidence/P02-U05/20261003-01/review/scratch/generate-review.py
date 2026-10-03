import hashlib,json,pathlib
root=pathlib.Path(r'E:\Xiadie\Xiadie'); rev=root/'.runtime/P02/reviews/u05-final'; wt=root/'.runtime/P02/worktrees/u05'
author='339d8cc7417e430faa21483bbc10b29baed46cac'; baseline='18a35406efaccce964ea53327d7af6d636c115f1'
def artifact(base,rel):
    data=(base/rel).read_bytes(); return {'root':('author_worktree' if base==wt else 'review_directory' if base==rev else 'baseline_repository'),'path':rel.as_posix() if isinstance(rel,pathlib.Path) else rel,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
review_artifacts=[
 ('author_worktree','evidence/P02-U05/20261003-01/baseline.json'),
 ('author_worktree','evidence/P02-U05/20261003-01/manifest.json'),
 ('author_worktree','evidence/P02-U05/20261003-01/command-index.json'),
 ('author_worktree','evidence/P02-U05/20261003-01/result.md'),
 ('author_worktree','evidence/P02-U05/20261003-01/ready-for-review.md'),
 ('author_worktree','evidence/P02-U05/20261003-01/inputs-final-02-pre.json'),
 ('author_worktree','evidence/P02-U05/20261003-01/inputs-final-02-post.json'),
 ('review_directory','author-verification.json'),
 ('review_directory','inputs-pre.json'),
 ('review_directory','inputs-post.json'),
 ('review_directory','binding-comparison.json'),
 ('review_directory','counterexamples-03.json'),
 ('review_directory','scratch/independent-counterexamples.mjs'),
 ('review_directory','scratch/audit-freeze-index.py'),
 ('review_directory','commands/verify-author.json'),
 ('review_directory','commands/bind-pre.json'),
 ('review_directory','commands/build-independent.json'),
 ('review_directory','commands/unit-u05-independent.json'),
 ('review_directory','commands/bind-post.json'),
 ('review_directory','commands/freeze-index-audit.json'),
 ('review_directory','commands/counterexamples-independent.json'),
 ('review_directory','commands/counterexamples-independent-02.json'),
 ('review_directory','commands/counterexamples-independent-03.json'),
]
artifacts=[]
for kind,rel in review_artifacts:
    base={'author_worktree':wt,'review_directory':rev}[kind]
    artifacts.append({'root':kind,'path':rel,'bytes':(base/rel).stat().st_size,'sha256':hashlib.sha256((base/rel).read_bytes()).hexdigest()})
immutable_paths=[
 'planning/Xiadie_V2_v1.1/tasks/P02-U05.md',
 'docs/sources.lock.json',
 'evidence/P02-U04/20261003-01/acceptance.json',
 'evidence/P02-U03/20261003-01/acceptance.json',
 'evidence/P02-U02/20261003-01/acceptance.json',
 'docs/adr/P02-reuse.md',
 'spikes/P02/sqlite-notes.md',
]
immutable=[artifact(root,p) for p in immutable_paths]
# `root` labels above resolve as baseline_repository because root is the project root.
checks=[
 {'id':'exact-target-prerequisite-and-manifest','status':'pass','detail':'冻结 author WT 精确为 339d8cc7417e430faa21483bbc10b29baed46cac，branch p02-u05、clean；baseline 18a35406efaccce964ea53327d7af6d636c115f1 为祖先。独立 verify-author 重算 55 个 manifest 条目/56 条变化路径，逐项比对 author raw Git blob 与磁盘，0 mismatch；manifest SHA-256 f3c888a158c75ea27c2daf9d248fab8422a3b07971869cc6ec13fee6666c5f57。冻结 baseline 中 U05 卡、sources.lock、U04 accepted prerequisite 的 bytes/SHA 均吻合；U02/U03 接受记录与 ADR/SQLite 来源笔记保持原样。'},
 {'id':'scope-and-command-index','status':'pass','detail':'56 条变化路径都在已登记映射范围：packages/storage/events、migrations、tsconfig.json、tools/run-tests.mjs、U05 evidence；没有 P01/Host/reference/global 改动。42/42 command-index 记录与原始 run JSON 及归档副本的 byte length/SHA 完全匹配；后续两个冻结/evidence commit 相对实现提交只改 U05 evidence。'},
 {'id':'independent-input-bindings','status':'pass','detail':'固定 Node v24.14.0 / TypeScript 6.0.2；独立 pre/post 各 108 项（含 --extra migrations/001-event-store.ts）逐行等于作者 inputs-final-02-pre/post，digest 均为 34c5146d0fa68e4440cc31b38626a2a603afd8709b2b559775d2b589457eab39；build、11 项 suite 及补充反例前后 bindings 无变化。'},
 {'id':'independent-build-and-u05-suite','status':'pass','detail':'用固定 Node 独立运行 tsc --project tsconfig.json：exit 0；tools/run-tests.mjs unit P02-U05：exit 0，11/11 pass、0 fail。原始 argv/cwd/stdout/stderr 保存在 review commands。Node SQLite ExperimentalWarning 与作者证据一致。'},
 {'id':'independent-fault-counterexamples','status':'pass','detail':'独立 scratch 3/3：真实 SQLite COMMIT 完成后注入 ACK throw，append 返回 unknown/UNKNOWN_COMMIT，重开 receipt found，重试 duplicate 且仅 1 fact/1 observation；transcript_materials 插入 trigger 失败时 fact/observation/origin/receipt/material 全部为 0、writer sequence 为 0，解除故障后从序号 1 成功；篡改 receipt hash 后 queryReceipt 以 CORRUPT_STORE fail closed。复审夹具前两次尝试分别遇到 reviewer cleanup 的 Windows -shm EBUSY 与 Node SQLite null-prototype 行比较；调整 reviewer 自有夹具后最终 3/3 通过，失败命令原样留档。'},
 {'id':'source-choice-and-evidence-boundaries','status':'pass','detail':'实现采用已接受 U02 选择的固定 Node 内置 node:sqlite，无新增依赖；来源 ADR、PoC 注记、U02/U03/U04 accepted inputs 均保留。SQLite/page-cap 与 owned worker 终止是实际本地 SQLite/子进程证据，不代表物理断电或磁盘填满；transcript 仍受 U04 full-mask/capture contract 限定。'},
]
report={
 'schema':'p02-independent-review/v1','decision':'pass','task':'P02-U05',
 'review_target':{'author_commit':author,'baseline_commit':baseline,'author_worktree':str(wt)},
 'reviewer':'p02_u04_review','scope':'P02-U05 exact-commit 独立单元验收；不构成 P02-G02 或后续 U08/U10 产品集成验收。',
 'checks':checks,
 'limitations':[
  '未运行完整 P01 回归或完整产品 Host/Electron/原生 Hook 配对；U10 负责 hook pairing，U08 负责在线备份/迁移/恢复。',
  '本轮未打开或改写产品数据库；无物理磁盘耗尽、物理断电或生产恢复演练。SQLITE_FULL 使用受控 page cap，崩溃检查只终止本测试拥有的 Node worker。',
  'Node v24.14.0 的 node:sqlite 显示 ExperimentalWarning；本审查验证固定 Node 工具链，不据此声称 Electron ABI/原生运行时兼容。',
 ],
 'artifacts':artifacts,
 'immutable_inputs':immutable,
}
path=rev/'review-final.json'; path.write_bytes((json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode())
print(json.dumps({'path':str(path),'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'artifacts':len(artifacts),'immutable_inputs':len(immutable)},ensure_ascii=False))
