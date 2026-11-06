# HTTP Client

::: v-pre

Send requests to your API from `.http` files (also `.rest`): plain text you can commit next to your
code, with variables, environments and the responses of earlier requests.

## Requests in a file

Requests are separated by `###` lines, with an optional title after it:

```http
@api = {{host}}/api

### Log in
# @name login
POST {{api}}/login
Content-Type: application/json

{"email": "{{email}}", "password": "{{password}}"}

### Orders
GET {{api}}/orders?page=2
Authorization: Bearer {{login.response.body.token}}
```

- **▶ in the gutter** beside each request sends it; <kbd>Ctrl+Enter</kbd> sends the one at the caret.
  The editor's right-click menu has *Send All Requests*.
- **The response** opens in the *HTTP Client* tool window: status, time and size, the body
  pretty-printed (JSON folds, HTML has a preview, images show), the headers, and the request as it
  was sent.
- **Copy as cURL** puts the request on the clipboard as a `curl` command.

New to `.http` files? *Tools ▸ HTTP Client* (or the HTTP Client window's **+**) opens a scratch
file in `.blitz/http/`, with an example. The *Endpoints* window's *Open in HTTP Client* writes a
request for a route there.

## Variables and environments

- **File variables**: `@name = value` lines, for the requests after them.
- **Environments**: `http-client.env.json` next to the `.http` file (or at the project root) holds
  a set of variables per environment. Put secrets in `http-client.private.env.json` and keep that
  file out of Git. Pick the environment in the HTTP Client window.

  ```json
  {
    "dev": { "host": "http://localhost:8000", "email": "dev@example.com" },
    "staging": { "host": "https://staging.example.com" }
  }
  ```
- **Responses**: name a request with `# @name login`, then later requests use
  `{{login.response.body.token}}` (a path into its JSON), `{{login.response.headers.Location}}` or
  `{{login.response.status}}`.
- **Built-in values**: `{{$uuid}}`, `{{$timestamp}}` (seconds), `{{$isoTimestamp}}`,
  `{{$randomInt}}` (0 to 999).

A request with a variable that has no value isn't sent: the HTTP Client window says which one.

### Options

Comment lines before the request line:

| Option | What |
| --- | --- |
| `# @name login` | Its response is `{{login.response…}}` in later requests |
| `# @no-redirect` | Don't follow redirects |
| `# @no-cookie-jar` | Don't send or keep cookies |
| `# @no-cert-check` | Accept any TLS certificate (a local server's own) |
| `# @timeout 30` | Seconds (or `500 ms`) |

Cookies the server sets are sent back on later requests to the same host, like a browser.
*Clear Cookies* in the HTTP Client window forgets them.

## The Requests view

The switch at the top right of a `.http` file shows it as a form instead of text: the file's
requests in a list, and for the selected one the method, the URL and a **Send** button, with tabs:

- **Params**: the URL's query as key and value rows.
- **Headers**: one row per header; uncheck a row to keep the header without sending it (it becomes
  a `#` comment line).
- **Body**: None, JSON, Multipart form, Form URL-encoded, XML, Text or File. Choosing one sets the
  `Content-Type` header.
- **Settings**: the request's name, timeout, redirects, cookies and certificate check.

The response is below the form. The file stays the source: each change in the form is an edit of
that request's lines, so comments, variables and everything else in the file are kept, and
<kbd>Ctrl+Z</kbd> in the text view undoes it.

## Sending files

- **A whole file as the body**: Body ▸ *File*, then *Browse…* (or type the path). In the text:

  ```http
  POST {{host}}/api/avatar
  Content-Type: image/png

  < ./files/avatar.png
  ```
- **A file upload in a form**: Body ▸ *Multipart form*; give a field the *File* type and pick the
  file. In the text:

  ```http
  POST {{host}}/api/upload
  Content-Type: multipart/form-data; boundary=boundary

  --boundary
  Content-Disposition: form-data; name="title"

  Holiday photo
  --boundary
  Content-Disposition: form-data; name="photo"; filename="beach.png"
  Content-Type: image/png

  < ./files/beach.png
  --boundary--
  ```

Paths are relative to the `.http` file's folder. Files are sent as they are, images and PDFs
included. A text file (`< ./payload.json`) in a JSON body is put in its place, with its variables
filled in.

## History

The HTTP Client window lists the requests you sent, newest first; double-click one to go to it in
its file, or *Send Again*. The history (the last 100), the named responses and the cookies are kept
in `.blitz/cache/http-client.json`, so they're still there after a restart. That file is
git-ignored and readable by your user only: it holds tokens and cookies. *Clear History* empties it.

Scripts in `.http` files (`> {% … %}` blocks) aren't run; named responses cover the usual case of
reusing a token.
:::
