import unittest
from unittest.mock import Mock, patch

import numpy as np

import app


class WorkerModelTests(unittest.TestCase):
    def setUp(self):
        app.model = None
        app.loaded_model_name = None
        app.model_error = None

    @patch.object(app, "WhisperModel")
    def test_local_models_are_downloaded_on_demand_and_reused(self, whisper_model):
        whisper_model.side_effect = [object(), object()]
        first = app.ensure_local_model("tiny")
        self.assertIs(first, app.ensure_local_model("tiny"))
        second = app.ensure_local_model("base")
        self.assertIsNot(first, second)
        self.assertEqual(whisper_model.call_count, 2)
        self.assertEqual(whisper_model.call_args_list[0].args[0], "tiny")
        self.assertEqual(whisper_model.call_args_list[1].args[0], "base")

    @patch.object(app.requests, "post")
    def test_openai_key_is_an_authorization_header_and_response_is_normalized(self, post):
        response = Mock(ok=True)
        response.json.return_value = {"text": "Привет", "language": "ru"}
        post.return_value = response
        result = app.transcribe_cloud(
            np.ones(1600, dtype=np.float32) * 0.01,
            "ru", "openai", "gpt-4o-mini-transcribe", "secret-test-key",
        )
        request = post.call_args.kwargs
        self.assertEqual(request["headers"]["Authorization"], "Bearer secret-test-key")
        self.assertNotIn("secret-test-key", str(request["data"]))
        self.assertEqual(result[0]["text"], "Привет")
        self.assertEqual(result[0]["endMs"], 100)

    @patch.object(app.requests, "post")
    def test_cloud_http_errors_do_not_echo_credentials(self, post):
        post.return_value = Mock(ok=False, status_code=401)
        with self.assertRaises(Exception) as raised:
            app.transcribe_cloud(
                np.ones(1600, dtype=np.float32),
                "auto", "mistral", "voxtral-mini-latest", "do-not-echo-this-key",
            )
        self.assertNotIn("do-not-echo-this-key", str(raised.exception))

    @patch.object(app.requests, "post")
    def test_realtime_profile_uses_batch_model_for_authoritative_chunk_output(self, post):
        response = Mock(ok=True)
        response.json.return_value = {"text": "Финальный текст", "language": "ru"}
        post.return_value = response
        result = app.transcribe_cloud(
            np.ones(1600, dtype=np.float32) * 0.01,
            "ru", "mistral", "voxtral-mini-transcribe-realtime-2602", "secret-test-key",
        )
        self.assertEqual(post.call_args.kwargs["data"]["model"], "voxtral-mini-latest")
        self.assertEqual(result[0]["text"], "Финальный текст")

    def test_realtime_profile_is_accepted_only_for_mistral(self):
        app.validate_profile("mistral", "voxtral-mini-transcribe-realtime-2602")
        with self.assertRaises(Exception):
            app.validate_profile("openai", "voxtral-mini-transcribe-realtime-2602")


if __name__ == "__main__":
    unittest.main()
