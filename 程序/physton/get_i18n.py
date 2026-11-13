import os
import json

i18n = {}


def get_i18n(reload=False):
    global i18n
    if reload or not i18n:
        i18n = {}
        current_dir = os.path.dirname(__file__)
        config_file = os.path.join(current_dir, '../../../../i18n.json')
        config_file = os.path.normpath(config_file)
        try:
            with open(config_file, 'r', encoding='utf8') as f:
                i18n = json.load(f)
        except Exception:
            # i18n.json 不在也没关系：get_lang 会退回返回键名，不至于让报错信息本身崩掉
            i18n = {}
    return i18n
