import copy
import hashlib
import json
import tempfile
from pathlib import Path
import unittest
from relay_guards import ASSET_SHA, GuardRejection, completed_read_calls, public_sse, require, safe_failure_message, validate_child_config, validate_read_targets, validate_request


class RelayGuardTests(unittest.TestCase):
    def test_external_permission_error_text_is_never_recorded(self):
        canary = 'SYNTHETIC_SECRET_IN_EXTERNAL_ERROR'
        for error in (PermissionError(canary), PermissionError(13, 'denied', canary), RuntimeError(canary)):
            self.assertEqual(safe_failure_message(error), 'transport or parsing failure')
            self.assertNotIn(canary, safe_failure_message(error))
        with self.assertRaises(GuardRejection) as caught:
            require(False, 'model not authorized')
        self.assertEqual(safe_failure_message(caught.exception), 'model not authorized')

    def fixture(self, failure=False):
        scenario = {'id':'failure_read' if failure else 'technical_read','max_requests':2,'target':'missing.txt' if failure else 'readme.txt'}
        packet = '{"instruction":"遐蝶的已批准合成人设"}'
        context = {'scenario_id':scenario['id'],'request_index':1,'session_id':'s1','turn_id':'t1',
                   'canonical_packet':packet,'receipt':{'version':1,'nonce':'n1','event':'UserPromptSubmit',
                   'sessionId':'s1','turnId':'t1','character':{'id':'xiadie','version':'v3','contentSha256':ASSET_SHA},
                   'packetSha256':hashlib.sha256(packet.encode()).hexdigest()}}
        body = {'model':'deepseek-flash','stream':True,'max_tokens':1024,'thinking':{'type':'disabled'},
                'messages':[{'role':'system','content':'You are ZCode'},{'role':'user','content':packet}],
                'tools':[{'type':'function','function':{'name':'Read'}}]}
        return body,scenario,context

    def check(self, body, scenario, context, receipts=None, ids=None):
        return validate_request(body,'deepseek-flash',scenario,context['request_index'],context,receipts or [],ids or set())

    def continuation(self, failure=False):
        body,scenario,context = self.fixture(failure)
        context['request_index']=2
        body['messages'] += [{'role':'tool','tool_call_id':'read-1','content':'missing' if failure else 'orchid-42'}]
        receipt = {'scenario_id':scenario['id'],'session_id':'s1','turn_id':'t1','tool_call_id':'read-1',
                   'tool_name':'Read','event_type':'tool_call_error' if failure else 'tool_call_result','result_success':not failure}
        return body,scenario,context,[receipt],{'read-1'}

    def test_initial_packet_and_genuine_success_failure_continuations(self):
        self.check(*self.fixture())
        self.check(*self.continuation())
        self.check(*self.continuation(failure=True))

    def test_missing_packet_wrong_asset_and_wrong_hook_turn_are_denied(self):
        for fault in ('packet','asset','turn','nonce'):
            with self.subTest(fault=fault):
                body,scenario,context = self.fixture()
                if fault=='packet': body['messages'][1]['content']='wrong'
                if fault=='asset': context['receipt']['character']['contentSha256']='wrong'
                if fault=='turn': context['receipt']['turnId']='old-turn'
                if fault=='nonce': context['receipt']['nonce']=''
                with self.assertRaises(PermissionError): self.check(body,scenario,context)

    def test_continuation_cannot_use_missing_or_cross_session_receipts(self):
        for fault in ('missing','session','turn','tool','outcome'):
            with self.subTest(fault=fault):
                args=list(self.continuation())
                if fault=='missing': args[3]=[]
                elif fault=='outcome': args[3][0]['result_success']=False
                else: args[3][0][{'session':'session_id','turn':'turn_id','tool':'tool_call_id'}[fault]]='wrong'
                with self.assertRaises(PermissionError): self.check(*args)

    def test_unsafe_route_cap_and_other_tools_are_denied(self):
        for field,value in [('model','unapproved'),('stream',False),('max_tokens',1025),('max_tokens',True),('thinking',{'type':'enabled'})]:
            with self.subTest(field=field,value=value):
                body,scenario,context=self.fixture(); body[field]=value
                with self.assertRaises(PermissionError): self.check(body,scenario,context)
        body,scenario,context=self.fixture()
        body['tools'][0]['function']['name']='Bash'
        with self.assertRaises(PermissionError): self.check(body,scenario,context)
        body,scenario,context=self.fixture(); context['request_index']=3
        with self.assertRaises(PermissionError): self.check(body,scenario,context)

    def test_private_paths_and_tool_replay_are_denied(self):
        for message in ({'role':'user','content':r'C:\Users\liyi\.zcode\provider.json'},
                        {'role':'tool','tool_call_id':'old','content':'old result'}):
            body,scenario,context=self.fixture(); body['messages'].append(message)
            with self.assertRaises(PermissionError): self.check(body,scenario,context)

    def test_truncated_or_wrong_tool_stream_does_not_authorize_continuation(self):
        frame={'model':'deepseek-flash','choices':[{'index':0,'delta':{'tool_calls':[{'index':0,'id':'read-1','type':'function','function':{'name':'Read','arguments':'{}'}}]},'finish_reason':'tool_calls'}]}
        self.assertEqual(completed_read_calls([frame],b'data: [DONE]\n'),{'read-1'})
        self.assertEqual(completed_read_calls([frame],b''),set())
        bad=copy.deepcopy(frame); bad['choices'][0]['delta']['tool_calls'][0]['function']['name']='Write'
        self.assertEqual(completed_read_calls([bad],b'data: [DONE]\n'),set())

    def test_saved_stream_whitelists_public_fields_only(self):
        frame={'model':'deepseek-flash','reasoning':'PRIVATE_REASONING',
               'choices':[{'index':0,'delta':{'role':'assistant','content':'PUBLIC','reasoning_content':'PRIVATE_REASONING',
                   'tool_calls':[{'index':0,'id':'r1','type':'function','reasoning_content':'PRIVATE_REASONING',
                                  'function':{'name':'Read','arguments':'{}','thinking':'PRIVATE_REASONING'}}]},'finish_reason':'stop'}]}
        raw=('data: '+json.dumps(frame)+'\n\ndata: [DONE]\n').encode()
        frames,saved=public_sse(raw)
        self.assertIn('reasoning_content',frames[0]['choices'][0]['delta'])
        self.assertNotIn(b'PRIVATE_REASONING',saved)
        self.assertIn(b'PUBLIC',saved)
        self.assertIn(b'[DONE]',saved)

    def test_read_target_must_match_named_fixture_before_native_execution(self):
        # TemporaryDirectory is owned and created here; the context removes only this fixture.
        with tempfile.TemporaryDirectory(prefix='u09-relay-test-') as directory:
            self.assertEqual(Path(directory).resolve().parent,Path(tempfile.gettempdir()).resolve())
            self.assertTrue(Path(directory).name.startswith('u09-relay-test-'))
            scenario={'target':'readme.txt'}
            def frames(target):
                return [{'choices':[{'index':0,'finish_reason':'tool_calls','delta':{'tool_calls':[
                    {'index':0,'id':'r1','type':'function','function':{'name':'Read','arguments':json.dumps({'file_path':target})}}
                ]}}]}]
            self.assertEqual(validate_read_targets(frames('readme.txt'),b'data: [DONE]\n',directory,scenario),{'r1'})
            for target in ('../outside.txt','missing.txt',r'C:\outside\fixture.txt',r'\\not-authorized.invalid\share\file'):
                with self.subTest(target=target), self.assertRaises(PermissionError):
                    validate_read_targets(frames(target),b'data: [DONE]\n',directory,scenario)
            with self.assertRaises(PermissionError):
                validate_read_targets(frames('readme.txt'),b'data: [DONE]\n',directory,{'id':'daily'})

    def test_parent_rejects_bridge_env_secret_or_foreign_home(self):
        root=Path(r'E:\synthetic-u09-profile')
        relative={'HOME':'home','USERPROFILE':'home','APPDATA':'home/AppData/Roaming',
                  'LOCALAPPDATA':'home/AppData/Local','TEMP':'temp','TMP':'temp',
                  'ZCODE_DATA_BASE_DIR':'data','ZCODE_STORAGE_DIR':'storage','ZCODE_DESKTOP_HOME_DIR':'home',
                  'ZCODE_DESKTOP_USER_DATA_DIR':'userData','ZCODE_DESKTOP_SESSION_DATA_DIR':'sessionData'}
        env={key:str(root/value) for key,value in relative.items()}
        env.update(ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT='1',ZCODE_ENDPOINT_ORIGIN='http://127.0.0.1:55001',ZCODE_BASE_URL='http://127.0.0.1:55001')
        paths={name:str(root/relative) for name,relative in {
            'root':'','profileFile':'profile.json','home':'home','data':'data','temp':'temp','workspace':'workspace',
            'storage':'storage','userData':'userData','sessionData':'sessionData',
            'appData':'home/AppData/Roaming','localAppData':'home/AppData/Local'}.items()}
        config={'env':env,'profile':{'schemaVersion':1,'providerId':'deepseek-official','modelId':'deepseek-flash','networkMode':'offline'},
                'paths':paths,'credential_decision':{'decision':'no-key'}}
        validate_child_config(config,root,'http://127.0.0.1:55001')
        for key,value in [('DEEPSEEK_API_KEY','SYNTHETIC_SECRET_CANARY'),('HOME',r'C:\Users\foreign')]:
            changed=copy.deepcopy(config); changed['env'][key]=value
            with self.assertRaises(PermissionError): validate_child_config(changed,root,'http://127.0.0.1:55001')
        changed=copy.deepcopy(config); changed['apiKey']='SYNTHETIC_SECRET_CANARY'
        with self.assertRaises(PermissionError): validate_child_config(changed,root,'http://127.0.0.1:55001')
        changed=copy.deepcopy(config); changed['paths']['apiKey']='SYNTHETIC_SECRET_CANARY'
        with self.assertRaises(PermissionError): validate_child_config(changed,root,'http://127.0.0.1:55001')


if __name__=='__main__':
    unittest.main()
