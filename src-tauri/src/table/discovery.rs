//! Finding tables on the local network with mDNS / DNS-SD, the same
//! mechanism printers and AirPlay use. A hosting GM registers
//! `_campaignforge._tcp.local.`; a player browses for it. Networks with
//! client isolation (guest and corporate Wi-Fi) block this, which is why the
//! join screen also takes a typed address.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;

pub const SERVICE_TYPE: &str = "_campaignforge._tcp.local.";

/// The name a hosting machine answers to on the LAN, the same for every GM
/// so the phone address is always `http://forge.local/`. The daemon answers
/// A queries for it (RFC 6762 host records) and probes before announcing;
/// if another GM on the same network already holds it, mDNS renames ours
/// and players fall back to the IP addresses, which are always shown too.
pub const HOST_NAME: &str = "forge.local";

/// A table seen on the network.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundTable {
    /// mDNS full name; stable while the table is up.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub system: Option<String>,
    /// `ip:port` candidates, IPv4 only, sorted.
    pub addresses: Vec<String>,
}

/// A hosted table's registration. Unregisters on drop.
pub struct Registration {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Drop for Registration {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

/// Announces a table. `ips` are the host's LAN addresses; with none given,
/// mDNS picks them up itself.
pub fn register(
    campaign: &str,
    system: Option<&str>,
    ips: &[Ipv4Addr],
    port: u16,
) -> Result<Registration, String> {
    let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?;
    let instance = campaign
        .chars()
        .map(|c| if c == '.' { ' ' } else { c })
        .collect::<String>();
    let instance = instance.trim();
    let instance = if instance.is_empty() {
        "Campaign Forge"
    } else {
        instance
    };
    let host = format!("{HOST_NAME}.");
    let mut props: Vec<(&str, String)> = vec![("campaign", campaign.to_owned())];
    if let Some(system) = system {
        props.push(("system", system.to_owned()));
    }
    let addrs: Vec<IpAddr> = ips.iter().copied().map(IpAddr::V4).collect();
    let info = ServiceInfo::new(SERVICE_TYPE, instance, &host, &addrs[..], port, &props[..])
        .map_err(|e| format!("mDNS registration failed: {e}"))?;
    let info = if addrs.is_empty() {
        info.enable_addr_auto()
    } else {
        info
    };
    let fullname = info.get_fullname().to_owned();
    daemon
        .register(info)
        .map_err(|e| format!("mDNS registration failed: {e}"))?;
    Ok(Registration { daemon, fullname })
}

/// A browse in progress. Results accumulate until stopped.
pub struct Browser {
    daemon: ServiceDaemon,
    found: Arc<Mutex<HashMap<String, FoundTable>>>,
}

impl Browser {
    pub fn start() -> Result<Browser, String> {
        let daemon = ServiceDaemon::new().map_err(|e| format!("mDNS unavailable: {e}"))?;
        let receiver = daemon
            .browse(SERVICE_TYPE)
            .map_err(|e| format!("mDNS browse failed: {e}"))?;
        let found: Arc<Mutex<HashMap<String, FoundTable>>> = Arc::default();
        let sink = found.clone();
        std::thread::spawn(move || {
            while let Ok(event) = receiver.recv() {
                match event {
                    ServiceEvent::ServiceResolved(info) => {
                        let port = info.get_port();
                        let mut addresses: Vec<String> = info
                            .get_addresses_v4()
                            .into_iter()
                            .filter(|ip| !ip.is_loopback() && !ip.is_link_local())
                            .map(|ip| format!("{ip}:{port}"))
                            .collect();
                        addresses.sort();
                        let fullname = info.get_fullname().to_owned();
                        let name = info
                            .get_property_val_str("campaign")
                            .map(str::to_owned)
                            .unwrap_or_else(|| instance_of(&fullname));
                        let system = info.get_property_val_str("system").map(str::to_owned);
                        if let Ok(mut map) = sink.lock() {
                            map.insert(
                                fullname.clone(),
                                FoundTable {
                                    id: fullname,
                                    name,
                                    system,
                                    addresses,
                                },
                            );
                        }
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        if let Ok(mut map) = sink.lock() {
                            map.remove(&fullname);
                        }
                    }
                    _ => {}
                }
            }
        });
        Ok(Browser { daemon, found })
    }

    pub fn tables(&self) -> Vec<FoundTable> {
        let mut out: Vec<FoundTable> = self
            .found
            .lock()
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.daemon.stop_browse(SERVICE_TYPE);
        let _ = self.daemon.shutdown();
    }
}

fn instance_of(fullname: &str) -> String {
    fullname
        .strip_suffix(SERVICE_TYPE)
        .map(|s| s.trim_end_matches('.'))
        .unwrap_or(fullname)
        .to_owned()
}

/// A DNS-safe label for this machine.
/// This machine's LAN IPv4 addresses, most useful first: home-network
/// ranges on physical adapters before VPN tunnels and virtual switches, so
/// the address players are told (and the QR code) points at the Wi-Fi
/// rather than at a VPN.
pub fn lan_ipv4_addresses() -> Vec<Ipv4Addr> {
    let mut found: Vec<(u8, Ipv4Addr)> = local_ip_address::list_afinet_netifas()
        .map(|ifs| {
            ifs.into_iter()
                .filter_map(|(name, ip)| match ip {
                    IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => {
                        Some((address_rank(&name, v4), v4))
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    found.sort();
    let mut out: Vec<Ipv4Addr> = Vec::new();
    for (_, ip) in found {
        if !out.contains(&ip) {
            out.push(ip);
        }
    }
    out
}

/// Lower is better. Adapter names that smell of VPNs or virtual machines go
/// after everything else; within a group, 192.168.x.x beats 172.16-31.x.x
/// beats 10.x.x.x beats anything public.
fn address_rank(adapter: &str, ip: Ipv4Addr) -> u8 {
    const VIRTUAL: [&str; 17] = [
        "vpn",
        "proton",
        "wireguard",
        "wintun",
        "tap-",
        "tun",
        "tailscale",
        "zerotier",
        "hamachi",
        "vethernet",
        "virtualbox",
        "vmware",
        "hyper-v",
        "docker",
        "wsl",
        "npcap",
        "loopback",
    ];
    let name = adapter.to_ascii_lowercase();
    let is_virtual = VIRTUAL.iter().any(|k| name.contains(k));
    let o = ip.octets();
    let range = if o[0] == 192 && o[1] == 168 {
        0
    } else if o[0] == 172 && (16..=31).contains(&o[1]) {
        1
    } else if o[0] == 10 {
        2
    } else {
        3
    };
    if is_virtual { 10 + range } else { range }
}
