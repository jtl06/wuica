import sys, os, json, gzip, subprocess, contextlib, io, glob
uicaDir = os.path.expanduser('~/uica-zen/uiCA-perf')
here = os.path.dirname(os.path.abspath(__file__))
if len(sys.argv) > 1:
    f = os.path.abspath(sys.argv[1])
    sys.path.insert(0, here)
    import export_fixtures as E
    out = open(sys.argv[2], 'w')
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        E.init(uicaDir)
        import xed
        from microArchConfigs import MicroArchConfigs as M
        hexStr = ''.join(i['opcode'] for i in xed.disasFile(f, chip='ALL'))
    name = os.path.basename(f)
    for chip in sorted(set(c.XEDName for c in M.values())):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            instrs = xed.disasHex(hexStr, chip=chip)
        out.write('D ' + json.dumps({'file': name, 'chip': chip, 'hex': hexStr, 'instrs': instrs}) + '\n')
    for arch in sorted(M):
        if arch in E.SKIP_ARCHS: continue
        for options in [{}, {'alignmentOffset': 5}, {'alignmentOffset': 31}, {'noMicroFusion': True}, {'noMacroFusion': True}]:
            base = {'file': name, 'arch': arch, 'options': options, 'hex': hexStr}
            try:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    r = E.instrCase(hexStr, arch, options)
            except BaseException as e:
                r = {'error': type(e).__name__ + ': ' + str(e)[:200]}
            out.write('I ' + json.dumps(dict(base, **r)) + '\n')
    out.close()
else:
    with gzip.open(os.path.join(here, 'y_decode.jsonl.gz'), 'wt') as fd, gzip.open(os.path.join(here, 'y_instr.jsonl.gz'), 'wt') as fi:
        for s in sorted(glob.glob(os.path.join(here, 'y_*.s'))):
            o = s[:-2] + '.o'
            r = subprocess.run(['as', s, '-o', o], capture_output=True, text=True)
            if r.returncode != 0:
                print('AS FAILED', s, r.stderr); continue
            tmp = o + '.out'
            r = subprocess.run([sys.executable, os.path.abspath(__file__), o, tmp], capture_output=True, text=True)
            nd = ni = ne = 0
            for l in open(tmp).read().split('\n'):
                if l.startswith('D '): fd.write(l[2:] + '\n'); nd += 1
                elif l.startswith('I '): fi.write(l[2:] + '\n'); ni += 1; ne += '"error": ' in l[-300:]
            print(os.path.basename(s), nd, ni, 'errors', ne, r.stderr[-300:] if r.returncode else '')
