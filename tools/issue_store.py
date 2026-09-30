"""Version-scoped review records; model assets are never modified."""
import math
import uuid
import asset_store as S

STATUSES = ('open', 'review', 'closed', 'wontfix')
MAX_COMMENT = 4000
MAX_TRANSLATION_ROWS = 20000


def invalid(message):
    raise S.StoreError('invalid_issue', message, 400)


def normalize(issue):
    """补齐双语字段。老记录只有 text（= 中文原文），这里只做读取期回填，不改写文件。

    commentZh 是 text 的只读镜像：原文永不改写，English 只落在 commentEn。
    """
    if not issue.get('commentZh'):
        issue['commentZh'] = issue.get('text', '')
    if not isinstance(issue.get('commentEn'), str):
        issue['commentEn'] = ''
    return issue


def vector(value, size=3):
    if not isinstance(value, list) or len(value) != size or any(
        isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in value
    ):
        invalid('坐标 / 相机数据无效')
    return value


def read(pid, mid, vid):
    path = S.require_version(pid, mid, vid) / 'issues.json'
    if path.exists():
        doc = S.read_json(path)
        for issue in doc.get('issues', []):
            normalize(issue)
        return doc
    return dict(schema='model-review-issues/1', projectId=pid, modelId=mid,
                versionId=vid, coordinateSpace='gltf-world-meters', issues=[])


def create(pid, mid, vid, body):
    if not isinstance(body, dict):
        invalid('批注数据无效')
    text = body.get('text')
    node = body.get('node')
    camera = body.get('camera')
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_COMMENT:
        invalid('批注须为 1–4000 个字符')
    if not isinstance(node, dict) or not isinstance(node.get('canonicalId'), str) or not node['canonicalId']:
        invalid('缺少关联节点')
    if not isinstance(camera, dict):
        invalid('缺少相机视角')
    pose = {k: vector(camera.get(k)) for k in ('position', 'target', 'up')}
    pose['quaternion'] = vector(camera.get('quaternion'), 4)
    for key in ('fov', 'near', 'far'):
        value = camera.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            invalid('相机参数无效')
        pose[key] = value
    if pose['near'] >= pose['far'] or pose['fov'] >= 180:
        invalid('相机范围无效')
    position = vector(body.get('position'))
    source = body.get('positionSource')
    if source not in ('surface', 'object-center'):
        invalid('定位来源无效')
    with S.LOCK:
        doc = read(pid, mid, vid)
        identity = str(uuid.uuid4())
        issue = dict(id=identity, lineageId=identity, inheritedFrom=None,
                     projectId=pid, modelId=mid, versionId=vid, originVersionId=vid,
                     number=max((i['number'] for i in doc['issues']), default=0) + 1,
                     text=text.strip(), commentZh=text.strip(), commentEn='',
                     node={k: node.get(k) for k in ('canonicalId', 'txtId', 'name')},
                     position=position, positionSource=source, camera=pose,
                     createdAt=S.now_iso(), updatedAt=S.now_iso(), status='open', revision=1,
                     bindingStatus='bound')
        doc['issues'].append(issue)
        S.write_json(S.require_version(pid, mid, vid) / 'issues.json', doc)
        return issue


def update(pid, mid, vid, iid, body):
    if not isinstance(body, dict) or body.get('status') not in STATUSES:
        invalid('批注状态无效')
    with S.LOCK:
        doc = read(pid, mid, vid)
        issue = next((i for i in doc['issues'] if i['id'] == iid), None)
        if issue is None:
            raise S.StoreError('issue_not_found', '批注不存在', 404)
        if body.get('revision') != issue['revision']:
            raise S.StoreError('issue_conflict', '批注已被更新，请重新加载后再修改', 409)
        issue.update(status=body['status'], updatedAt=S.now_iso(), revision=issue['revision'] + 1)
        S.write_json(S.require_version(pid, mid, vid) / 'issues.json', doc)
        return issue


def _match_key(issues, token):
    """序号优先（导出用的稳定标识），非纯数字则按 id 精确匹配；一律精确，不做模糊。"""
    key = str(token if token is not None else '').strip()
    if not key:
        return None, dict(reason='empty_key', key=key)
    if key.isdigit():
        found = next((i for i in issues if i['number'] == int(key)), None)
    elif len(key) >= 8:
        found = next((i for i in issues if str(i['id']).lower() == key.lower()), None)
    else:
        found = None
    if found is None:
        return None, dict(reason='not_found', key=key)
    return found, None


def apply_translations(pid, mid, vid, body):
    """按序号把英文批注写回对应 Issue；只写 commentEn，中文原文永不改动。"""
    if not isinstance(body, dict):
        invalid('翻译数据无效')
    rows = body.get('items')
    if not isinstance(rows, list) or not rows:
        invalid('没有可导入的翻译数据')
    if len(rows) > MAX_TRANSLATION_ROWS:
        invalid('一次最多导入 20000 行')
    with S.LOCK:
        doc = read(pid, mid, vid)
        issues = doc.get('issues', [])
        updated, unmatched, skipped, duplicated = [], [], [], []
        for row in rows:
            if not isinstance(row, dict):
                skipped.append(dict(key='', reason='bad_row'))
                continue
            issue, error = _match_key(issues, row.get('key'))
            if error:
                unmatched.append(dict(error, commentEn=str(row.get('commentEn') or '').strip()))
                continue
            english = row.get('commentEn')
            if not isinstance(english, str) or not english.strip():
                skipped.append(dict(key=str(row.get('key')).strip(), number=issue['number'],
                                    reason='empty_translation'))
                continue
            english = english.strip()
            if len(english) > MAX_COMMENT:
                skipped.append(dict(key=str(row.get('key')).strip(), number=issue['number'],
                                    reason='too_long'))
                continue
            if issue['id'] in {u['id'] for u in updated}:
                duplicated.append(issue['number'])
            issue['commentEn'] = english                      # 只写英文，commentZh / text 保持不变
            issue['translatedAt'] = S.now_iso()
            issue['updatedAt'] = S.now_iso()
            issue['revision'] += 1
            updated.append(issue)
        if updated:
            S.write_json(S.require_version(pid, mid, vid) / 'issues.json', doc)
        return dict(issues=issues,
                    updated=[dict(id=i['id'], number=i['number'], commentEn=i['commentEn'])
                             for i in updated],
                    unmatched=unmatched, skipped=skipped, duplicated=duplicated,
                    counts=dict(total=len(rows), updated=len(updated),
                                unmatched=len(unmatched), skipped=len(skipped)))
