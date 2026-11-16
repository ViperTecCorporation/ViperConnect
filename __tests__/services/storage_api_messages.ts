import { apiMessage } from '../../src/services/api_messages'
import { localizeApiError } from '../../src/services/api_error_localization'

test.each(['session_storage_registration_required', 'session_storage_active_calls', 'session_storage_voip_gate_required',
  'session_storage_provision_unconfirmed', 'session_storage_provision_changed', 'session_storage_configuration_changed',
  'session_storage_internal_fields', 'session_storage_auto_connect_invalid', 'mobile_auth_import_required',
  'mobile_storage_selection_required', 'mobile_storage_selection_invalid', 'mobile_auth_import_unconfirmed',
  'session_storage_primary_unavailable', 'session_storage_primary_auth_invalid', 'session_storage_primary_auth_lease_required',
  'session_storage_primary_auth_lease_lost', 'session_storage_primary_auth_requires_paused', 'session_storage_primary_auth_conflict',
  'session_storage_standalone_confirmation_required', 'session_storage_standalone_destination_exists', 'session_storage_standalone_configuration_invalid',
  'session_storage_standalone_recovery_required', 'session_storage_standalone_restore_failed', 'session_storage_worker_unavailable', 'session_storage_request_expired',
  'session_storage_wrong_owner', 'session_storage_busy', 'session_storage_upload_size_invalid', 'session_storage_upload_incomplete', 'session_storage_backup_requires_s3',
  'mobile_auth_conflict', 'mobile_auth_removed_registration_required', 'mobile_session_in_use', 'mobile_session_conflict',
  'commander_config_invalid', 'commander_config_protected_fields',
  'session_storage_operation_in_progress', 'session_storage_generation_changed', 'mobile_backup_sqlite_requires_session_storage_endpoint',
  'session_storage_media_id_mapping_invalid',
  'session_backup_sqlite_requires_session_storage_endpoint', 'jidmap_unavailable', 'pairing_code_unavailable',
  'passkey_bridge_not_found_or_expired', 'passkey_bridge_session_mismatch', 'passkey_bridge_session_not_active',
  'passkey_bridge_result_unconfirmed', 'passkey_bridge_update_conflict'])('public storage error %s has actionable PT/EN text and a stable code', code => {
  const pt = apiMessage(code, 'pt-BR'), en = apiMessage(code, 'en')
  expect(pt).not.toBe(code); expect(en).not.toBe(code); expect(en).not.toBe(pt)
  expect(localizeApiError({ error: code }).error_code).toBe(code)
})
