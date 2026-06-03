// SPDX-License-Identifier: AGPL-3.0-only
/*
 * Copyright 2025-2026 Triton One Limited. All rights reserved.
 */

use solana_message::{self, MESSAGE_VERSION_PREFIX, VersionedMessage, legacy, v0};
use solana_signature::Signature;
use solana_transaction::versioned;
use wincode::{
    SchemaWrite, Serialize, WriteResult,
    containers::{self, Pod},
    io::Writer,
    len::short_vec::ShortU16Len,
};

#[derive(SchemaWrite)]
#[wincode(from = "solana_message::MessageHeader", struct_extensions)]
struct MessageHeader {
    num_required_signatures: u8,
    num_readonly_signed_accounts: u8,
    num_readonly_unsigned_accounts: u8,
}

#[derive(SchemaWrite)]
#[wincode(from = "solana_message::compiled_instruction::CompiledInstruction")]
struct CompiledInstruction {
    program_id_index: u8,
    accounts: containers::Vec<Pod<u8>, ShortU16Len>,
    data: containers::Vec<Pod<u8>, ShortU16Len>,
}

#[derive(SchemaWrite)]
#[wincode(from = "legacy::Message")]
struct LegacyMessage {
    header: MessageHeader,
    account_keys: containers::Vec<Pod<solana_message::Address>, ShortU16Len>,
    recent_blockhash: Pod<solana_message::Hash>,
    instructions: containers::Vec<CompiledInstruction, ShortU16Len>,
}

#[derive(SchemaWrite)]
#[wincode(from = "v0::MessageAddressTableLookup")]
struct MessageAddressTableLookup {
    account_key: Pod<solana_message::Address>,
    writable_indexes: containers::Vec<Pod<u8>, ShortU16Len>,
    readonly_indexes: containers::Vec<Pod<u8>, ShortU16Len>,
}

#[derive(SchemaWrite)]
#[wincode(from = "v0::Message")]
struct V0Message {
    header: MessageHeader,
    account_keys: containers::Vec<Pod<solana_message::Address>, ShortU16Len>,
    recent_blockhash: Pod<solana_message::Hash>,
    instructions: containers::Vec<CompiledInstruction, ShortU16Len>,
    address_table_lookups: containers::Vec<MessageAddressTableLookup, ShortU16Len>,
}

#[derive(SchemaWrite)]
#[wincode(from = "versioned::VersionedTransaction")]
struct VersionedTransactionSchema {
    signatures: containers::Vec<Pod<Signature>, ShortU16Len>,
    message: VersionedMessageSchema,
}

struct VersionedMessageSchema;

impl SchemaWrite for VersionedMessageSchema {
    type Src = VersionedMessage;

    #[inline(always)]
    fn size_of(src: &Self::Src) -> WriteResult<usize> {
        match src {
            VersionedMessage::Legacy(message) => LegacyMessage::size_of(message),
            VersionedMessage::V0(message) => Ok(1 + V0Message::size_of(message)?),
        }
    }

    #[inline(always)]
    fn write(writer: &mut impl Writer, src: &Self::Src) -> WriteResult<()> {
        match src {
            VersionedMessage::Legacy(message) => LegacyMessage::write(writer, message),
            VersionedMessage::V0(message) => {
                u8::write(writer, &MESSAGE_VERSION_PREFIX)?;
                V0Message::write(writer, message)
            }
        }
    }
}

pub(crate) fn serialize_versioned_message(message: &VersionedMessage) -> WriteResult<Vec<u8>> {
    VersionedMessageSchema::serialize(message)
}

#[cfg(test)]
pub(crate) fn serialize_versioned_transaction(
    transaction: &versioned::VersionedTransaction,
) -> WriteResult<Vec<u8>> {
    VersionedTransactionSchema::serialize(transaction)
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_message::{
        Address, Hash, MessageHeader, VersionedMessage,
        compiled_instruction::CompiledInstruction,
        legacy::Message,
        v0::{Message as V0Message, MessageAddressTableLookup},
    };

    #[test]
    fn serializes_legacy_message_with_solana_short_vec_lengths() {
        let message = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 0,
            },
            account_keys: vec![Address::from([1; 32]), Address::from([2; 32])],
            recent_blockhash: Hash::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 1,
                accounts: vec![0],
                data: vec![1, 2, 3],
            }],
        });

        let mut expected = vec![1, 0, 0, 2];
        expected.extend([1; 32]);
        expected.extend([2; 32]);
        expected.extend([0; 32]);
        expected.extend([1, 1, 1, 0, 3, 1, 2, 3]);

        assert_eq!(serialize_versioned_message(&message).unwrap(), expected);
    }

    #[test]
    fn serializes_v0_message_with_version_prefix_and_lookup_tables() {
        let message = VersionedMessage::V0(V0Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 1,
            },
            account_keys: vec![Address::from([1; 32]), Address::from([2; 32])],
            recent_blockhash: Hash::new_from_array([9; 32]),
            instructions: vec![CompiledInstruction {
                program_id_index: 1,
                accounts: vec![0],
                data: vec![7, 8],
            }],
            address_table_lookups: vec![MessageAddressTableLookup {
                account_key: Address::from([3; 32]),
                writable_indexes: vec![4, 5],
                readonly_indexes: vec![6],
            }],
        });

        let mut expected = vec![MESSAGE_VERSION_PREFIX, 1, 0, 1, 2];
        expected.extend([1; 32]);
        expected.extend([2; 32]);
        expected.extend([9; 32]);
        expected.extend([1, 1, 1, 0, 2, 7, 8, 1]);
        expected.extend([3; 32]);
        expected.extend([2, 4, 5, 1, 6]);

        assert_eq!(serialize_versioned_message(&message).unwrap(), expected);
    }
}
