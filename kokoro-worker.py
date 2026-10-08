"""Private CPU voice worker. stdout is reserved for the JSON-lines protocol."""
import base64
import contextlib
import io
import json
import sys

with contextlib.redirect_stdout(sys.stderr):
    import onnxruntime as ort
    import soundfile as sf
    from kokoro_onnx import Kokoro

    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"])
    kokoro = Kokoro.from_session(session, sys.argv[2])

def emit(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)

emit({"ready": True})
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        text = request["text"]
        speed = request["speed"]
        if not isinstance(text, str) or not 0 < len(text) <= 600 or speed not in (1.0, 0.75):
            raise ValueError("Invalid voice request")
        with contextlib.redirect_stdout(sys.stderr):
            samples, rate = kokoro.create(text, voice=request["voice"], speed=speed, lang="en-us")
            output = io.BytesIO()
            sf.write(output, samples, rate, format="WAV", subtype="PCM_16")
        emit({"id": request["id"], "audio": base64.b64encode(output.getvalue()).decode("ascii")})
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr, flush=True)
        emit({"id": request.get("id"), "error": "Kokoro could not generate audio"})
