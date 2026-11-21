#!/usr/bin/env python3
"""Generate private per-slot mTLS certificates. Output must never be committed."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.write_bytes(content); path.chmod(0o600)


def generate(root, slots, *, extra_dns=()):
    ca_key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Greenroom Local Dev CA')])
    now = datetime.now(timezone.utc)
    ca = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(ca_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=365)).add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True).sign(ca_key, hashes.SHA256())
    ca_bytes = ca.public_bytes(serialization.Encoding.PEM)
    def certificate(directory, prefix, cn, dns, usages):
        key = ec.generate_private_key(ec.SECP256R1())
        builder = x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=5)).not_valid_after(now+timedelta(days=90)).add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True).add_extension(x509.ExtendedKeyUsage(usages), critical=False)
        if dns: builder = builder.add_extension(x509.SubjectAlternativeName([x509.DNSName(value) for value in dns]), critical=False)
        cert = builder.sign(ca_key, hashes.SHA256())
        write(directory/(prefix+'.crt'), cert.public_bytes(serialization.Encoding.PEM))
        write(directory/(prefix+'.key'), key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        write(directory/'ca.crt', ca_bytes)
    certificate(root/'edge', 'edge', 'greenroom-edge', [], [ExtendedKeyUsageOID.CLIENT_AUTH])
    certificate(root/'edge', 'broker', 'greenroom-broker', list(extra_dns), [ExtendedKeyUsageOID.SERVER_AUTH])
    for member in slots:
        name_slot = 'dsh-local'
        certificate(root/name_slot, 'connector', member, list(extra_dns), [ExtendedKeyUsageOID.CLIENT_AUTH, ExtendedKeyUsageOID.SERVER_AUTH])
    # CA signing key is deliberately not persisted: leaf rotation replaces the
    # whole app-specific set. Rotate before 90 days and restart all slots together.

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--output', required=True); parser.add_argument('--slots', required=True)
    args = parser.parse_args(); generate(Path(args.output), json.loads(Path(args.slots).read_text()))
