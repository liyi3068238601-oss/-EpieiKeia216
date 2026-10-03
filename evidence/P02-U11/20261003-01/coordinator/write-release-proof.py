"""Generate an author freeze from completed, archived actual 0.2 candidate proofs."""
import argparse, hashlib, json, pathlib
p = argparse.ArgumentParser()
p.add_argument('worktree')
a = p.parse_args()
root = pathlib.Path(r'E:\Xiadie\Xiadie').resolve()
tree = pathlib.Path(a.worktree).resolve()
assert tree == root / '.runtime/P02/worktrees/u11'
ev = tree / 'evidence/P02-U11/20261003-01'
rel = tree / 'docs/releases/0.2.0'
status = json.loads((tree / 'evidence/P02/status.json').read_bytes())
assert status['current_task'] == 'P02-U11' and status['next_stage_started'] is False
assert all(t['status'] == 'accepted' for t in status['tasks'] if t['id'] != 'P02-U11')
assert json.loads((tree / 'package.json').read_bytes())['version'] == '0.2.0'
base = json.loads((ev / 'baseline.json').read_bytes())
audit = json.loads((ev / 'prerequisite-audit.json').read_bytes())
assert len(audit['accepted_prerequisites']) == 10 and not audit['plan_mismatches']
pre = json.loads((ev / 'commands/tests-01-inputs-before.json').read_bytes())
post = json.loads((ev / 'commands/tests-02-inputs-after.json').read_bytes())
assert post['unchanged'] and pre['bindings'] == post['bindings']
desc_file = ev / 'candidate-proof/candidate-descriptor.json'
desc = json.loads(desc_file.read_bytes())
proofs = {}
for suite, count in [('full', 6), ('degradation', 3)]:
    file = ev / 'candidate-proof/runs' / suite / 'summary.json'
    d = json.loads(file.read_bytes())
    assert d['passed'] and d['production_unchanged'] and d['execution_unchanged']
    assert d['external_model_requests'] == 0 and d['DSH_started'] is False
    assert len(d['scenarios']) == count
    assert all(s['passed'] and s['ledger_verification']['passed'] for s in d['scenarios'])
    proofs[suite] = {'passed': count, 'total': count, 'external_model_requests': 0}
def bind(file):
    data = file.read_bytes()
    return {'path': file.relative_to(tree).as_posix(), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
def absolute_bind(file):
    file = file.resolve()
    data = file.read_bytes()
    return {'path': str(file), 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
def group(predicate):
    selected = [i for i in desc['repositoryInputs'] if predicate(i['path'])]
    return {'count': len(selected), 'bindings_sha256': hashlib.sha256(json.dumps(selected, sort_keys=True, separators=(',', ':')).encode()).hexdigest(), 'files': selected}
frozen = {
    'schema': 'xiadie-local-freeze/v1', 'product_version': '0.2.0', 'plan_document_version': '1.1',
    'author_status': 'ready_for_review', 'accepted': False, 'G02': 'pending_independent_acceptance',
    'author_snapshot_boundary': 'Canonical current acceptance is evidence/P02/status.json and U11 acceptance.json written by coordinator after independent review.',
    'baseline_commit': base['baseline_commit'], 'build_repository_commit': desc['repositoryCommit'],
    'source_commit': desc['sourceCommit'], 'candidate_root': desc['assemblyRoot'],
    'descriptor': bind(desc_file), 'cli': desc['cli'],
    'artifact_count': len(desc['artifacts']), 'repository_input_count': len(desc['repositoryInputs']),
    'input_groups': {
        'code': group(lambda s: s.startswith('packages/') or s == 'tests/integration/P02/durable-host.mjs'),
        'prompt': group(lambda s: s.startswith('assets/character/') or s.startswith('plugins/xiadie/hooks/')),
        'schema': group(lambda s: s.startswith('migrations/')),
        'resources': group(lambda s: s.startswith(('assets/', 'plugins/'))),
        'tools_and_configuration': group(lambda s: s.startswith('tools/') or s in ('package.json', 'pnpm-lock.yaml', 'tsconfig.json')),
        'qualification_tests': group(lambda s: s.startswith('tests/integration/')),
    },
    'group_boundary': 'Theme groups may overlap. The descriptor repositoryInputs array is the complete declared material-input index.',
    'schema_version': 1, 'component_version_boundary': 'Xiadie root metadata is 0.2.0; unchanged identity plugin is independently versioned 0.1.0; pinned upstream keeps its own version.',
    'source_lock': bind(tree / 'docs/sources.lock.json'),
    'upstream_license': next(i for i in desc['artifacts'] if i['path'].split('/')[-1] == 'UPSTREAM-LICENSE'),
    'third_party_notices': next(i for i in desc['artifacts'] if i['path'].endswith('cli/dist/THIRD-PARTY-NOTICES.md')),
    'prerequisite_audit': bind(ev / 'prerequisite-audit.json'),
    'proof_archive_index': bind(ev / 'candidate-proof-index.json'),
    'command_index': bind(ev / 'command-index.json'), 'test_results': proofs,
    'execution_inputs': {'before': bind(ev / 'commands/tests-01-inputs-before.json'),
                         'after': bind(ev / 'commands/tests-02-inputs-after.json'), 'digest': pre['digest']},
    'generation_script': bind(ev / 'coordinator/write-release-proof.py'),
    'summaries': [bind(ev / ('candidate-proof/runs/' + s + '/summary.json')) for s in proofs],
    'toolchain': {'node_version': desc['nodeVersion'], 'node': absolute_bind(pathlib.Path(desc['nodePath'])),
                  'typescript': absolute_bind(tree / 'node_modules/typescript/package.json'),
                  'source_pin': desc['sourceCommit'], 'boundary': 'Declared executable/compiler entries only; not the entire dependency closure.'},
    'stop_after': 'P02-U11/G02', 'next_node': 'P03-U01', 'next_stage_started': False,
    'qualification': 'Actual Electron UI with fixed Node CLI SQLite and synthetic loopback backend. Local development assembly with borrowed pinned dependencies; not installer/portable/public release or full dependency closure.',
}
rel.mkdir(parents=True, exist_ok=False)
def save(file, content):
    assert not file.exists()
    file.write_text(content.rstrip() + '\n', encoding='utf-8', newline='\n')
save(rel / 'freeze.json', json.dumps(frozen, ensure_ascii=False, indent=2))
intro = f'''# Xiadie 0.2.0 本机开发候选冻结

作者快照：ready_for_review，accepted:false，G02 待独立判定。当前权威结果见 [P02 状态](../../../evidence/P02/status.json) 和 [G02 接受记录](../../../evidence/P02-U11/20261003-01/acceptance.json)（接受后由协调者生成）；本页与 freeze.json 保留作者提交时的快照。

沿用 ZCode 原生 UI/Runtime 与 P01 已接受的精简 v3 遐蝶人设，保留历史版本；默认官方 DeepSeek Flash 路线不变。新增已提交事件、来源追踪、幂等写入、未知效果恢复约束、一致性备份/新根恢复和脱敏诊断。SQLite 位于固定 Node CLI 协议进程，非 Electron main；P01 sidecar 仍是 UI 关联证据，没有新增 renderer 证据面板。

实际候选构建提交 `{desc['repositoryCommit']}`，上游 `{desc['sourceCommit']}`。descriptor SHA-256 `{frozen['descriptor']['sha256']}`，绑定 {len(desc['artifacts'])} 个产物、{len(desc['repositoryInputs'])} 个项目输入；CLI SHA-256 `{desc['cli']['sha256']}`。后续作者证据提交不是构建提交。[freeze.json](freeze.json) 保存完整分组哈希和证据索引，原候选保留于 `{desc['assemblyRoot']}`。

实际 0.2.0 候选重新构建并重跑：桌面主流程 **6/6**，无 Key/无 DSH/离线降级 **3/3**，每个账本状态验真均通过；生产配置及执行输入前后不变，固定 9229 禁用，动态 loopback 端口，无 DSH、无本轮付费调用。底层已接受 U10 的 82 项单元回归、作者/独立 Native8/8 和独立9场景账本状态复核作为阶段证据，分别记录，不把 mock 当付费模型。未准入或禁用场景按契约验证零事实/无账本，不声称存在已提交历史。P01 官方模型小样本评测是历史证据。

| 条目 | 实际依据 | 范围 |
| --- | --- | --- |
| G02 来源可追 | U03/U04/U05/U09、U10 实际 Native hook 与来源/回执；本次候选 hashes | 临时原文仅历史 hash/locator；currentValidation=NOT_VERIFIED |
| G02 已提交事实可恢复 | U07 重开恢复、U08 新根恢复、U10/U11 实际账本备份恢复 | 不恢复原文、主回复或整段对话；无事实时不编造历史 |
| G02 失败重试不伪造历史 | U05 重复/冲突/unknown ACK，U07 owned effect 一次与 child-kill，U10 BUSY/no replay | 未知效果需核查；非任意外部写入/发送/生成保证 |
| R03/R04/R05/R24 | [阶段需求映射](../../evals/P02/requirement-evidence.md)、十项先决接受、423项计划 hash 与实际 UI/SQLite reports | 仅 P02 阶段范围，非全项目 Must 关闭 |

目前是依赖本机固定源码/依赖目录的开发 assembly。安装器、可移植交付、真实 Desktop 付费路由、人工视觉验收、完整多会话编辑/并发、物理断电/磁盘故障及完整依赖闭包未验证。当前消息全遮蔽摄取不等于完整 transcript；诊断 turnSeal unavailable，历史扫描受上限约束。工作证据是固定 owned-artifact-integrity 机械核验，不代表任意业务结果。网络 guard 是进程 instrumentation，非 OS sandbox。角色游戏背景保留不构成原创 IP 或公共分发许可证明；上游 Apache-2.0 与第三方 notices 保留。Node SQLite 保留 experimental 警告。

[作者结果](../../../evidence/P02-U11/20261003-01/result.md) 与 [回滚](../../../evidence/P02-U11/20261003-01/rollback.md) 保存精确命令、cwd、exit、风险与保留路径。本轮不执行公开发布。下一节点为 [P03-U01](../../../planning/Xiadie_V2_v1.1/tasks/P03-U01.md)：原生 MEMORY 路径/索引/迁移/子代理 scope 和 ADR/交接模板调查；停在 G02，不自动启动该节点。
'''
save(rel / 'README.md', intro)
save(ev / 'source-decision.md', '''# U11 来源与路径映射

复用已独立接受的 U01-U10、固定 Native 来源和 P02 candidate/driver/ledger verifier；无新依赖、上游代码或角色素材移植。目标 docs/releases/0.2.0 映射至该目录，另包含 root package.json 的 0.2.0 版本/当前阶段 e2e 入口和 README 的当前进度链接，以及本单元 evidence。此为冻结元数据/验收入口映射，不增加产品功能或修改 accepted packages/P01/规划/上游/用户配置。

先把元数据提交，再实际编译和构建新候选，随后实际 full/degradation；证据提交在后。候选 descriptor 绑定 clean build commit 的原始 Git blob 和当前 bytes。严格区分本轮 loopback mock、真实 Native/Electron/Node/SQLite、历史 P01 官方模型、未交付 installer/portable。公共角色分发许可和完整环境闭包不被本地冻结冒充。
''')
save(ev / 'rollback.md', '''# 回滚与保留

保留历史 P01/G01 0.1.0 候选、全部人格版本、U01-U10 接受证据、失败记录及隔离数据库。代码/元数据回退采用显式 revert，禁止重写共享历史或覆盖未提交内容。使用旧候选时采用其独立旧配置/profile，不把 0.2 数据库直接降级或交给旧版本。

数据修复先用已接受 U08 对关闭/排空 writer 做一致性备份并验证，恢复到全新的自有根目录；future schema/非空未知 v0 不自动迁移。未知外部效果先人工/有效证据核查，不能删回执后盲重试。本轮只处理自有合成 profile，没有迁移生产数据库；不动已安装 ZCode。候选及 Node/Native 固定依赖保留在冻结索引给出的原位置。
''')
save(ev / 'result.md', f'''# P02-U11 作者冻结结果

状态 **ready_for_review**，不由作者宣称 accepted/G02 pass。基线 `{base['baseline_commit']}`；真实构建提交 `{desc['repositoryCommit']}`。精确后续证据 commit 由 manifest/独立接受索引固定，不能称候选在该后续 commit 构建。

root package 已在构建前设 0.2.0；实际 TypeScript build/candidate build exit0。新候选实际 full6/6 + degradation3/3、全部ledger checks、production/execution unchanged、外部模型0/DSH false。准确 argv/cwd/exit/stdout/stderr 在 commands 与 candidate-proof/commands 中，命令索引与 byte-identical proof archive index 均绑定。当前版本全组实际重验，不以源码阅读代替运行。

测试前后135项执行输入（含两份Python runner和static migration）字节一致，digest `{pre['digest']}`。冻结生成器源码及其真实运行命令另保存在 coordinator/ 中。第一次candidate build因新的自有父目录未创建而ENOENT失败，未产生候选；创建该父目录后成功构建。原始失败记录 candidate-proof/commands/01-build.json 保留，不以重试结果覆盖它。

来源/代码/prompt/schema/资源/配置及候选产物完整分组哈希、G02/R03/R04/R05/R24 映射、支持限制见 docs/releases/0.2.0/README.md 和 freeze.json。十个先决单元接受/独立review hash 与423项 immutable plan文件全部匹配，见 prerequisite-audit.json。root package/README 的路径映射、来源和回滚分别记于 source-decision.md/rollback.md；其他 accepted packages、P01、plan 与用户生产设置不变。

此为真实 Native/Electron/Node/SQLite 与 owned loopback mock 后端的本机开发 assembly，不是安装器/portable/public release、付费 Desktop 模型或人眼视觉验收；详细限制与unknown effect/no original-history/机械证据范围均见冻结说明。本轮停在独立 G02，未开始 P03。最终决定由独立审查与协调接受记录给出。
''')
print(json.dumps({'version': '0.2.0', 'candidate_commit': desc['repositoryCommit'], 'artifact_count': len(desc['artifacts']), 'input_count': len(desc['repositoryInputs']), 'author_status': 'ready_for_review'}))
