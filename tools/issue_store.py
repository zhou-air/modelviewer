"""Version-scoped review records; model assets are never modified."""
import math
import uuid
import asset_store as S

STATUSES = ('open', 'review', 'closed', 'wontfix')


def invalid(message):
    raise S.StoreError('invalid_issue', message, 400)


def vector(value, size=3):
    if not isinstance(value, list) or len(value) != size or any(
        isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in value
    ):
        invalid('坐标 / 相机数据无效')
    return value


def read(pid, mid, vid):
    path = S.require_version(pid, mid, vid) / 'issues.json'
    if path.exists():
        return S.read_json(path)
    return dict(schema='model-review-issues/1', projectId=pid, modelId=mid,
                versionId=vid, coordinateSpace='gltf-world-meters', issues=[])


def create(pid, mid, vid, body):
    if not isinstance(body, dict):
        invalid('批注数据无效')
    text = body.get('text')
    node = body.get('node')
    camera = body.get('camera')
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
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
                     text=text.strip(), node={k: node.get(k) for k in ('canonicalId', 'txtId', 'name')},
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
