# Profile picture metadata in webhooks

Unoapi sends profile picture URLs as presigned R2/S3 object URLs.
The object key is stable for each contact or group, so downstream consumers
should not use the URL path alone to decide whether the image changed.

When a cached profile picture exists in storage, Unoapi includes storage metadata beside the URL.

## Contact payload

```json
{
  "contacts": [
    {
      "profile": {
        "name": "Maria",
        "picture": "https://.../profile-pictures/556699999999.jpg?...",
        "picture_metadata": {
          "etag": "\"eaed9c5735d6cdf4b5416c800fb39868\"",
          "last_modified": "2026-06-15T19:24:29.000Z",
          "content_length": "41053",
          "content_type": "image/jpeg"
        }
      },
      "wa_id": "556699999999"
    }
  ]
}
```

## Group payload

```json
{
  "contacts": [
    {
      "group_id": "120363040468224422@g.us",
      "group_picture": "https://.../profile-pictures/120363040468224422%40g.us.jpg?...",
      "group_picture_metadata": {
        "etag": "\"eaed9c5735d6cdf4b5416c800fb39868\"",
        "last_modified": "2026-06-15T19:24:29.000Z",
        "content_length": "41053",
        "content_type": "image/jpeg"
      }
    }
  ]
}
```

## Source

For S3/R2 storage, metadata comes from `HeadObjectCommand`, which does not download the image. The presigned URL is still generated with `GetObjectCommand`.

Consumers can build a stable change signature from:

- normalized picture URL path
- `etag`
- `last_modified`
- `content_length`
- `content_type`

If metadata is absent, consumers may fall back to a small ranged request (`Range: bytes=0-0`) against the presigned URL.
