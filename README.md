# pixai-cli

An unofficial command-line client for the [PixAI](https://pixai.art) image generation API. It submits a generation task, waits for it, and saves the image.

This project is not affiliated with or endorsed by PixAI. It calls the PixAI REST API with your own API key; generating images spends credits on your PixAI account.

- No dependencies. Needs Node.js 18 or newer.
- Works for one image or a batch of jobs from a file.
- Can write a JSON record of the request beside each image, for reproducible art pipelines.
- Never prints or stores your API key.

## Install

```sh
npm install -g github:vin-spiegel/pixai-cli
```

Or run it without installing:

```sh
npx github:vin-spiegel/pixai-cli --help
```

## Set up

Create an API key in your PixAI account and put it in the environment:

```sh
export PIXAI_API_KEY=sk-...            # macOS, Linux
$env:PIXAI_API_KEY = 'sk-...'          # PowerShell
```

You can also keep it in a `.env` file and pass `--env-file .env`. Do not commit that file.

Every request needs a model version id. Pass it with `--model`, or set `PIXAI_MODEL_VERSION_ID` once.

## Generate one image

```sh
pixai generate \
  --prompt "1girl, silver hair, upper body portrait, cel shading" \
  --negative "lowres, extra fingers" \
  --model 1983308862240288769 \
  --aspect 9:16 --size 1.5k --mode pro --prompt-helper disable \
  --out art/hero.png
```

The command prints the saved path. The file extension follows the image PixAI returns, so `art/hero.png` may be saved as `art/hero.webp`. With `--batch-size` above 1, extra images are saved as `hero-2`, `hero-3`, and so on.

Existing files are never overwritten unless you pass `--force`; the check happens before the task is submitted, so a name clash does not cost credits.

Long prompts are easier to keep in files:

```sh
pixai generate --prompt-file hero.prompt.txt --negative-file hero.negative.txt -m 1983308862240288769 -o art/hero.png --record
```

`--record` writes `art/hero.json` with the task id, the time, the full request and the saved files.

Fields this tool has no flag for can be sent with `--param key=value`. The value is parsed as JSON when possible:

```sh
pixai generate -p "..." -m 1983308862240288769 -o out.png --param seed=42
```

## Run a batch

```json
{
  "defaults": {
    "model": "1983308862240288769",
    "aspect": "9:16",
    "size": "1.5k",
    "mode": "pro",
    "promptHelper": "disable",
    "negativeFile": "shared.negative.txt"
  },
  "jobs": [
    { "name": "hero-a", "promptFile": "hero-a.txt", "out": "out/hero-a.png" },
    { "name": "hero-b", "prompt": "1boy, red coat", "out": "out/hero-b.png" }
  ]
}
```

```sh
pixai batch jobs.json --record
```

Each job takes the same fields as the `generate` flags (`prompt`, `promptFile`, `negative`, `negativeFile`, `model`, `aspect`, `size`, `mode`, `batchSize`, `promptHelper`, `params`, `out`). Paths are relative to the jobs file. Jobs run one after another; a failed job is reported and the rest still run. The exit code is 1 if any job failed.

## Other commands

```sh
pixai generate ... --no-wait        # submit and print the task id
pixai task <taskId>                 # show the status and image URLs
pixai download <taskId> -o out.png  # save the images of a finished task
```

Add `--json` to any command for machine-readable output. Progress messages go to stderr, results to stdout.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | PixAI or network error, or a failed task |
| 2 | Invalid arguments |

## Use as a library

```js
import { createClient, mediaUrls } from 'pixai-cli';

const pixai = createClient({ apiKey: process.env.PIXAI_API_KEY });
const { id } = await pixai.createImage({ modelVersionId: '1983308862240288769', prompt: '...' });
const task = await pixai.waitForTask(id);
console.log(mediaUrls(task));
```

## API endpoints used

| Call | Endpoint |
| --- | --- |
| Create a task | `POST https://api.pixai.art/v2/image/create` |
| Read a task | `GET https://api.pixai.art/v1/task/{id}` |

Set `PIXAI_API_BASE` to point the client somewhere else.

## Development

```sh
npm test
```

The tests use a fake PixAI and do not spend credits.

## License

MIT
