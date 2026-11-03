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
    let host = format!("{}.local.", host_label());
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
fn host_label() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "campaign-forge".to_owned());
    let label: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let label = label.trim_matches('-');
    if label.is_empty() {
        "campaign-forge".to_owned()
    } else {
        label.to_owned()
    }
}

/// This machine's LAN IPv4 addresses, for the GM to read out.
pub fn lan_ipv4_addresses() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = local_ip_address::list_afinet_netifas()
        .map(|ifs| {
            ifs.into_iter()
                .filter_map(|(_, ip)| match ip {
                    IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out.dedup();
    out
}
