#!/usr/bin/env python3
"""List the files that the given files import and the files that import them.

Covers TS/JS, Python, Go, Rust, C# and Luau by parsing source text: no packages
needed. Imports into third-party code are dropped; only repository files are
listed.

usage: deps.py [FILE ...] [--base REF] [--depth N] [--json]

With no FILE, the working tree's changed and untracked files are used plus the
files changed in REF...HEAD, where REF defaults to the upstream branch, else
main. With FILE, only --base adds REF...HEAD's files.
"""
import argparse
import ast
import json
import os
import posixpath as pp
import re
import subprocess
import sys
from collections import defaultdict

TS_EXTS = ('.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs')
JS_EXTS = TS_EXTS[4:]
MAX_CHARS = 1_000_000


def git(root, *args, check=True):
    out = subprocess.run(['git', '-C', root, *args], capture_output=True, text=True, encoding='utf-8')
    if out.returncode != 0:
        if not check:
            return []
        sys.exit(out.stderr.strip() or f'git {" ".join(args)} failed')
    return [line for line in out.stdout.splitlines() if line]


def read(root, rel):
    try:
        with open(os.path.join(root, rel), encoding='utf-8', errors='replace') as f:
            text = f.read(MAX_CHARS + 1)
    except OSError:
        return ''
    return '' if len(text) > MAX_CHARS else text


STRINGS = {
    'ts': r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'|`(?:\\.|[^`\\])*`',
    'go': r'"(?:\\.|[^"\\\n])*"|`[^`]*`',
    'rs': r'"(?:\\.|[^"\\])*"',
    'cs': r'@"(?:""|[^"])*"|"(?:\\.|[^"\\\n])*"',
    'json': r'"(?:\\.|[^"\\])*"',
}
COMMENTS = {lang: re.compile(rf'({s})|//[^\n]*|/\*.*?\*/', re.S) for lang, s in STRINGS.items()}
COMMENTS['luau'] = re.compile(rf'({STRINGS["ts"]}|\[(=*)\[.*?\]\2\])|--\[(=*)\[.*?\]\3\]|--[^\n]*', re.S)


def strip_comments(text, lang):
    """Blank comments; strings are matched first so a comment marker inside one stays."""
    return COMMENTS[lang].sub(lambda m: m.group(1) or '', text)


def nearest(dirs, rel):
    """The deepest of dirs holding rel ('' is the repository root)."""
    return max((d for d in dirs if not d or rel.startswith(d + '/')), key=len, default=None)


def dotted_prefixes(name):
    """a.b.c -> a.b.c, a.b, a"""
    while name:
        yield name
        name = name.rpartition('.')[0]


class Repo:
    def __init__(self, root):
        self.root = root
        self.untracked = git(root, 'ls-files', '--others', '--exclude-standard')
        self.files = set(git(root, 'ls-files')) | set(self.untracked)

    def text(self, rel, lang=None):
        text = read(self.root, rel)
        return strip_comments(text, lang) if lang else text

    def jsonc(self, rel):
        """JSON that may carry comments and trailing commas (tsconfig, .luaurc, Rojo projects); {} when broken."""
        try:
            data = json.loads(re.sub(r',(\s*[}\]])', r'\1', self.text(rel, 'json')))
        except ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def first(self, candidates):
        return next((c for c in map(pp.normpath, candidates) if c in self.files), None)

    def module_file(self, base, exts, index):
        """A module is base + ext, or a folder's entry file base/index + ext."""
        return self.first([base + e for e in exts] + [pp.join(base, index + e) for e in exts])


# ---------- TS / JS ----------

TS_IMPORT = re.compile(
    r"""(?:\bimport\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?|\bexport\s+(?:type\s+)?[\w*{}\s,$]+\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]"""
)


class TsResolver:
    def __init__(self, repo):
        self.repo = repo
        self.configs = {}
        for f in repo.files:
            if pp.basename(f) in ('tsconfig.json', 'jsconfig.json'):
                config = self.load(f)
                if config:
                    self.configs[pp.dirname(f)] = config

    def load(self, rel):
        data = self.repo.jsonc(rel)
        if not data:
            return None
        opts = data.get('compilerOptions', {})
        d = pp.dirname(rel)
        base_url = pp.join(d, opts['baseUrl']) if 'baseUrl' in opts else None
        return base_url, base_url or d, opts.get('paths', {})

    def file(self, base):
        stem, ext = pp.splitext(base)
        exact = [base] + ([stem + e for e in TS_EXTS] if ext in JS_EXTS else [])
        return self.repo.first(exact) or self.repo.module_file(base, TS_EXTS, 'index')

    def resolve(self, rel, spec):
        if spec.startswith('.'):
            return self.file(pp.join(pp.dirname(rel), spec))
        d = nearest(self.configs, rel)
        if d is None:
            return None
        base_url, paths_root, paths = self.configs[d]
        for pattern, targets in paths.items():
            prefix, star, suffix = pattern.partition('*')
            if star and spec.startswith(prefix) and spec.endswith(suffix) and len(spec) >= len(prefix) + len(suffix):
                middle = spec[len(prefix):len(spec) - len(suffix)]
            elif not star and spec == pattern:
                middle = ''
            else:
                continue
            for t in targets:
                hit = self.file(pp.join(paths_root, t.replace('*', middle)))
                if hit:
                    return hit
        return self.file(pp.join(base_url, spec)) if base_url is not None else None

    def deps(self, rel):
        return {self.resolve(rel, m) for m in TS_IMPORT.findall(self.repo.text(rel, 'ts'))}


# ---------- Python ----------

class PyResolver:
    def __init__(self, repo):
        self.repo = repo
        self.by_module = defaultdict(list)
        for f in repo.files:
            if f.endswith('.py'):
                parts = f[:-3].split('/')
                if parts[-1] == '__init__':
                    parts.pop()
                for i in range(len(parts)):
                    self.by_module['.'.join(parts[i:])].append(f)

    def module(self, rel, dotted):
        """When several files are named dotted (a.py, lib/a.py), take the one nearest rel."""
        here = pp.dirname(rel)
        return max(
            self.by_module.get(dotted, ()),
            key=lambda h: len(pp.commonpath([here, pp.dirname(h)])) if here else 0,
            default=None,
        )

    def relative(self, rel, level, dotted):
        d = pp.dirname(rel)
        for _ in range(level - 1):
            d = pp.dirname(d)
        return self.repo.module_file(pp.join(d, *dotted.split('.')) if dotted else d, ['.py'], '__init__')

    def resolve(self, rel, level, dotted):
        """Longest match: a.b.C finds a/b.py when a/b/C.py does not exist."""
        for name in dotted_prefixes(dotted):
            hit = self.relative(rel, level, name) if level else self.module(rel, name)
            if hit:
                return hit
        return self.relative(rel, level, '') if level else None

    def deps(self, rel):
        try:
            tree = ast.parse(self.repo.text(rel))
        except (SyntaxError, ValueError):
            return set()
        out = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                out.update(self.resolve(rel, 0, a.name) for a in node.names)
            elif isinstance(node, ast.ImportFrom):
                mod = node.module or ''
                out.add(self.resolve(rel, node.level, mod))
                out.update(self.resolve(rel, node.level, f'{mod}.{a.name}'.strip('.')) for a in node.names if a.name != '*')
        return out


# ---------- Go ----------

GO_BLOCK = re.compile(r'^\s*import\s*\((.*?)\)', re.M | re.S)
GO_SINGLE = re.compile(r'^\s*import\s+(?:[\w.]+\s+)?"([^"]+)"', re.M)
GO_PATH = re.compile(r'"([^"]+)"')


class GoResolver:
    def __init__(self, repo):
        self.repo = repo
        self.modules = []
        for f in repo.files:
            if pp.basename(f) == 'go.mod':
                m = re.search(r'^module\s+(\S+)', repo.text(f), re.M)
                if m:
                    self.modules.append((m.group(1), pp.dirname(f)))
        self.modules.sort(key=lambda m: -len(m[0]))
        self.by_dir = defaultdict(list)
        for f in repo.files:
            if f.endswith('.go'):
                self.by_dir[pp.dirname(f)].append(f)

    def deps(self, rel):
        text = self.repo.text(rel, 'go')
        paths = GO_SINGLE.findall(text)
        for block in GO_BLOCK.findall(text):
            paths += GO_PATH.findall(block)
        out = set()
        for p in paths:
            for mod, d in self.modules:
                if p == mod or p.startswith(mod + '/'):
                    out.update(self.by_dir.get(pp.normpath(pp.join(d, p[len(mod) + 1:])) if p != mod else d, []))
                    break
        return out


# ---------- Rust ----------

RS_MOD = re.compile(r'^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;', re.M)
RS_USE = re.compile(r'\buse\s+((?:crate|super|self)(?:::[\w{}\s,:*]+)?)\s*;')


class RsResolver:
    def __init__(self, repo):
        self.repo = repo
        self.crates = [pp.dirname(f) for f in repo.files if pp.basename(f) == 'Cargo.toml']

    def module_dir(self, rel):
        d, name = pp.split(rel)
        stem = name[:-3]
        return d if stem in ('mod', 'lib', 'main') else pp.join(d, stem)

    def file_for(self, d, parts):
        for i in range(len(parts), 0, -1):
            hit = self.repo.module_file(pp.join(d, *parts[:i]), ['.rs'], 'mod')
            if hit:
                return hit
        return None

    def expand(self, path):
        """crate::a::{b, c::D} -> [crate::a::b, crate::a::c::D]"""
        path = re.sub(r'\s+', '', path)
        m = re.match(r'^(.*?)::\{(.*)\}$', path)
        if not m:
            return [path]
        depth, items, cur = 0, [], ''
        for ch in m.group(2):
            if ch == ',' and depth == 0:
                items.append(cur)
                cur = ''
                continue
            depth += (ch == '{') - (ch == '}')
            cur += ch
        items.append(cur)
        return [x for item in items if item for x in self.expand(f'{m.group(1)}::{item}')]

    def deps(self, rel):
        text = self.repo.text(rel, 'rs')
        crate = nearest(self.crates, rel)
        out = set()
        for use in [f'self::{m}' for m in RS_MOD.findall(text)] + RS_USE.findall(text):
            for path in self.expand(use):
                parts = [p for p in path.split('::') if p and p != '*']
                head, parts = parts[0], parts[1:]
                if head == 'crate':
                    d = pp.join(crate, 'src') if crate is not None else None
                elif head == 'self':
                    d = self.module_dir(rel)
                else:
                    d = pp.dirname(self.module_dir(rel))
                    while parts and parts[0] == 'super':
                        d, parts = pp.dirname(d), parts[1:]
                if d is not None and parts:
                    out.add(self.file_for(d, parts))
        return out


# ---------- C# ----------

CS_NAMESPACE = re.compile(r'^\s*namespace\s+([\w.]+)', re.M)
CS_USING = re.compile(r'^\s*(global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;', re.M)
CS_TYPE = re.compile(r'\b(?:class|struct|interface|enum|record|delegate\s+[\w<>\[\],\s]+?)\s+(\w+)')
CS_STRING = re.compile(STRINGS['cs'])


class CsResolver:
    """A file depends on another when it names one of that file's types and can see its namespace."""

    def __init__(self, repo):
        self.ns_of, self.usings, self.idents = {}, {}, {}
        self.type_files = defaultdict(set)
        self.global_usings = set()
        for f in repo.files:
            if not f.endswith('.cs'):
                continue
            text = CS_STRING.sub('""', repo.text(f, 'cs'))
            self.ns_of[f] = set(CS_NAMESPACE.findall(text))
            usings = CS_USING.findall(text)
            self.usings[f] = {n for _, n in usings}
            self.global_usings.update(n for g, n in usings if g)
            self.idents[f] = set(re.findall(r'\b[A-Z]\w*', text))
            for t in CS_TYPE.findall(text):
                self.type_files[t].add(f)

    def deps(self, rel):
        visible = self.usings[rel] | self.global_usings | {p for n in self.ns_of[rel] for p in dotted_prefixes(n)}
        return {
            f
            for ident in self.idents[rel]
            for f in self.type_files.get(ident, ())
            if f != rel and self.ns_of[f] & visible
        }


# ---------- Luau (Roblox / Rojo, Lune) ----------

LUAU_EXTS = ('.luau', '.lua')
LUAU_SCRIPT_EXTS = tuple(k + e for k in ('', '.server', '.client') for e in LUAU_EXTS)
LUAU_STRING_REQUIRE = re.compile(r'\brequire\s*\(?\s*["\'`]([^"\'`\n]+)["\'`]')
LUAU_REQUIRE = re.compile(r'\brequire\s*\(\s*([A-Za-z_][\w.:"\'\[\]()\s,]*?)\s*\)\s*(?:$|[\n;:]|--)', re.M)
LUAU_LOCAL = re.compile(r'^\s*local\s+(\w+)(?:\s*:\s*[\w.]+)?\s*=\s*([\w.:"\'\[\]()\s,]+?)\s*$', re.M)
LUAU_SEGMENT = r'\s*(?:\.\s*(\w+)|:\s*(?:WaitForChild|FindFirstChild|GetService)\s*\(\s*["\'](\w+)["\']\s*(?:,[^)]*)?\)|\[\s*["\'](\w+)["\']\s*\])'
LUAU_PATH = re.compile(rf'\s*(\w+)((?:{LUAU_SEGMENT})*)\s*')


def luau_stem(rel):
    """Rojo names an instance after its file, without .server/.client; init files name their folder."""
    stem = pp.join(pp.dirname(rel), re.sub(r'(\.server|\.client)?\.luau?$', '', pp.basename(rel)))
    return pp.dirname(stem) if pp.basename(stem) == 'init' else stem


class LuauResolver:
    """require("./x") and .luaurc aliases by path; require(script.Parent.X) and
    require(ReplicatedStorage.Shared.X) through the Rojo *.project.json trees."""

    def __init__(self, repo):
        self.repo = repo
        self.trees = defaultdict(dict)
        self.aliases = {}
        for f in repo.files:
            name, d = pp.basename(f), pp.dirname(f)
            if name.endswith('.project.json'):
                self.walk(self.trees[d], d, repo.jsonc(f).get('tree'), ())
            elif name == '.luaurc':
                self.aliases[d] = {k.lower(): pp.normpath(pp.join(d, v)) for k, v in repo.jsonc(f).get('aliases', {}).items()}

    def walk(self, out, d, node, names):
        if not isinstance(node, dict):
            return
        if isinstance(node.get('$path'), str):
            out[names] = pp.normpath(pp.join(d, node['$path']))
        for k, v in node.items():
            if not k.startswith('$'):
                self.walk(out, d, v, names + (k,))

    def module(self, base):
        return self.repo.first([base]) or self.repo.module_file(base, LUAU_SCRIPT_EXTS, 'init')

    def by_string(self, rel, stem, aliases, spec):
        here = pp.dirname(rel)
        head, _, rest = spec.partition('/')
        if head == '@self':
            return self.module(pp.join(here, rest))
        if head.startswith('@'):
            target = aliases.get(head[1:].lower())
            return self.module(pp.join(target, rest)) if target else None
        # ./ from an init file means the folder's siblings; older runtimes read it from the file's folder.
        bases = [pp.dirname(here), here] if stem == here else [here]
        return next((hit for b in bases if (hit := self.module(pp.join(b, spec)))), None)

    def instance(self, stem, expr, locals_, depth=0):
        """('fs', path parts) for paths off script, ('game', names) for paths off a service."""
        m = LUAU_PATH.fullmatch(expr)
        if not m or depth > 8:
            return None
        head = m.group(1)
        if head == 'script':
            kind, at = 'fs', tuple(p for p in stem.split('/') if p)
        elif head == 'game':
            kind, at = 'game', ()
        elif head == 'workspace':
            kind, at = 'game', ('Workspace',)
        elif head in locals_:
            base = self.instance(stem, locals_[head], locals_, depth + 1)
            if base is None:
                return None
            kind, at = base
        else:
            kind, at = 'game', (head,)
        for groups in re.findall(LUAU_SEGMENT, m.group(2)):
            n = ''.join(groups)
            at = at[:-1] if n == 'Parent' else at + (n,)
        return kind, at

    def by_instance(self, stem, tree, expr, locals_):
        found = self.instance(stem, expr, locals_)
        if found is None:
            return None
        kind, at = found
        if kind == 'fs':
            return self.module('/'.join(at))
        for i in range(len(at), 0, -1):
            if at[:i] in tree:
                return self.module(pp.join(tree[at[:i]], *at[i:]))
        return None

    def deps(self, rel):
        text = self.repo.text(rel, 'luau')
        stem = luau_stem(rel)
        aliases = self.aliases.get(nearest(self.aliases, rel), {})
        tree = self.trees.get(nearest(self.trees, rel), {})
        locals_ = dict(LUAU_LOCAL.findall(text))
        out = {self.by_string(rel, stem, aliases, spec) for spec in LUAU_STRING_REQUIRE.findall(text)}
        out.update(self.by_instance(stem, tree, expr, locals_) for expr in LUAU_REQUIRE.findall(text))
        return out


# ---------- graph ----------

RESOLVERS = {**{e: TsResolver for e in TS_EXTS}, '.py': PyResolver, '.go': GoResolver, '.rs': RsResolver, '.cs': CsResolver, **{e: LuauResolver for e in LUAU_EXTS}}


def build_graph(repo):
    active, imports = {}, {}
    for f in sorted(repo.files):
        cls = RESOLVERS.get(pp.splitext(f)[1])
        if cls:
            if cls not in active:
                active[cls] = cls(repo)
            imports[f] = sorted(d for d in active[cls].deps(f) if d and d != f)
    imported_by = defaultdict(set)
    for f, ds in imports.items():
        for d in ds:
            imported_by[d].add(f)
    return imports, {k: sorted(v) for k, v in imported_by.items()}


def default_base(root):
    upstream = git(root, 'rev-parse', '--abbrev-ref', '@{upstream}', check=False)
    if upstream:
        return upstream[0]
    return 'main' if git(root, 'rev-parse', '--verify', '--quiet', 'main', check=False) else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='*')
    ap.add_argument('--base', help='also include files changed in BASE...HEAD')
    ap.add_argument('--depth', type=int, default=1, help='hops to follow (default 1)')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    root = git(os.getcwd(), 'rev-parse', '--show-toplevel')[0]
    repo = Repo(root)
    if args.files:
        seeds = [pp.normpath(os.path.relpath(os.path.abspath(f), root).replace('\\', '/')) for f in args.files]
        base = args.base
    else:
        seeds = git(root, 'diff', '--name-only', 'HEAD') + repo.untracked
        base = args.base or default_base(root)
    if base:
        seeds += git(root, 'diff', '--name-only', f'{base}...HEAD')
    seeds = sorted(set(seeds) & repo.files)
    if not seeds:
        sys.exit('no changed files found')

    imports, imported_by = build_graph(repo)
    scope, frontier = set(seeds), set(seeds)
    for _ in range(max(args.depth, 0)):
        nxt = set()
        for f in frontier:
            nxt.update(imports.get(f, ()))
            nxt.update(imported_by.get(f, ()))
        frontier = nxt - scope
        scope |= frontier
    scope = sorted(scope)
    files = {f: {'imports': imports.get(f, []), 'imported_by': imported_by.get(f, [])} for f in seeds}

    if args.json:
        print(json.dumps({'root': root, 'changed': seeds, 'files': files, 'scope': scope}, indent=2, ensure_ascii=False))
        return
    print(f'root: {root}\n')
    for f, d in files.items():
        print(f)
        print('  imports:     ' + (', '.join(d['imports']) or '-'))
        print('  imported by: ' + (', '.join(d['imported_by']) or '-'))
    print(f'\nscope ({len(scope)} files):')
    for f in scope:
        print('  ' + f)


if __name__ == '__main__':
    main()
