"""自定义翻译接口（OpenAI 兼容）

不依赖 openai 库，直接用 requests 调 {接口地址}/chat/completions。
市面上 OpenAI / DeepSeek / 通义 / Kimi / 各类中转站都兼容这个格式，
填「接口地址 + API Key + 模型名」即可使用。
"""
import sys
import os
import json

sys.path.append(os.path.join(os.path.dirname(__file__), "../"))

import requests

from translator.base_tanslator import BaseTranslator


PROMPT = (
    "You are a translator assistant. Please translate the following JSON data {lang}. "
    "Preserve the original format. Only return the translation result, without any "
    "additional content or annotations. If the prompt word is in the target language, "
    "please send it to me unchanged:\n{body}"
)


class CustomOpenaiTranslator(BaseTranslator):
    def __init__(self):
        # 不走 translate_apis.json 的查表（自定义接口是动态的），手动给一份最简配置
        self.api = 'custom_openai'
        self.api_config = {}
        self.api_item = {
            'key': 'custom_openai',
            'name': '自定义（OpenAI 兼容）',
            'concurrent': 1,
            'support': {
                'zh_CN': 'Chinese', 'zh_TW': 'Chinese',
                'en_US': 'English', 'en_GB': 'English',
                'ja_JP': 'Japanese', 'ko_KR': 'Korean',
                'ru_RU': 'Russian', 'fr_FR': 'French',
                'de_DE': 'German', 'es_ES': 'Spanish',
            },
        }

    def translate(self, text):
        if not text:
            return [] if isinstance(text, list) else ''
        base = (self.api_config.get('api_base') or 'https://api.openai.com/v1').rstrip('/')
        api_key = (self.api_config.get('api_key') or '').strip()
        model = (self.api_config.get('model') or 'gpt-4o-mini').strip()
        if not api_key:
            raise Exception('请先在「设置 → 翻译 → 自定义（OpenAI 兼容）」里填写 API Key')

        items = text if isinstance(text, list) else [text]
        body = json.dumps([{'text': t} for t in items], ensure_ascii=False)
        payload = {
            'model': model,
            'temperature': 0,
            'messages': [
                {'role': 'system', 'content': 'You are a translator assistant.'},
                {'role': 'user', 'content': PROMPT.format(lang=self.to_lang, body=body)},
            ],
        }
        try:
            resp = requests.post(
                base + '/chat/completions',
                headers={'Authorization': 'Bearer ' + api_key, 'Content-Type': 'application/json'},
                json=payload,
                timeout=60,
            )
        except Exception as e:
            raise Exception('连接接口失败：' + str(e))

        if resp.status_code != 200:
            raise Exception('接口返回 %s：%s' % (resp.status_code, (resp.text or '')[:300]))
        try:
            data = resp.json()
            content = data['choices'][0]['message']['content']
        except Exception:
            raise Exception('接口返回内容无法解析：' + (resp.text or '')[:300])

        start, end = content.find('['), content.rfind(']')
        if start < 0 or end < 0:
            raise Exception('接口没有返回翻译结果（不是 JSON 格式）：' + content[:200])
        try:
            arr = json.loads(content[start:end + 1])
        except Exception:
            raise Exception('翻译结果解析失败：' + content[:200])

        out = [(x.get('text') if isinstance(x, dict) else str(x)) for x in arr]
        while len(out) < len(items):          # 返回少了就补空，避免错位
            out.append('')
        if isinstance(text, list):
            return out
        return out[0] if out else ''

    def translate_batch(self, texts):
        return self.translate(texts)          # 一次请求翻整批，比逐条快很多

    def get_concurrent(self):
        return 1
